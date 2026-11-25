import crypto from 'crypto';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import compression from 'compression';
import { PrismaClient } from '@prisma/client';
import { Webhook } from 'svix';
import { ClerkExpressRequireAuth } from '@clerk/clerk-sdk-node';
import Razorpay from 'razorpay';
import { encrypt, decrypt } from './utils/encryption';

interface AuthedRequest extends Request {
  auth?: { userId?: string | null };
  vendorId?: string;
}

const prisma = new PrismaClient();
const app = express();
const PACKING_FEE_INR = 10;

app.use(compression());

const requireAuth = ClerkExpressRequireAuth({}) as unknown as express.RequestHandler;

// Helper: Safely extract a single string param across Express type versions
function paramStr(val: string | string[] | undefined): string {
  if (!val) return '';
  return Array.isArray(val) ? String(val[0] || '') : String(val);
}

// Helper: Resolve Clerk ID or DB UUID (USED ONLY ON PUBLIC CUSTOMER ROUTES)
async function getDbVendorId(idParam: string | string[] | undefined): Promise<string | null> {
  const cleanId = paramStr(idParam).trim();
  if (!cleanId) return null;
  if (cleanId.startsWith('user_')) {
    const vendor = await prisma.vendor.findUnique({
      where: { clerkId: cleanId },
      select: { id: true },
    });
    return vendor ? vendor.id : null;
  }
  const vendor = await prisma.vendor.findUnique({
    where: { id: cleanId },
    select: { id: true },
  });
  return vendor ? vendor.id : null;
}

// Helper: Safely decrypt legacy plaintext or encrypted UPI strings
function safeDecrypt(value: string | null | undefined): string {
  if (!value) return '';
  try {
    return decrypt(value);
  } catch {
    return value;
  }
}

// Helper: Salted scrypt PIN hashing (supports seamless upgrade from legacy 4-digit PINs)
function hashPin(pin: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pin, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPin(pin: string, stored: string): { valid: boolean; needsUpgrade: boolean } {
  if (!stored.includes(':')) {
    const a = Buffer.from(pin);
    const b = Buffer.from(stored);
    const valid = a.length === b.length && crypto.timingSafeEqual(a, b);
    return { valid, needsUpgrade: valid };
  }
  const [salt, keyHex] = stored.split(':');
  if (!salt || !keyHex) return { valid: false, needsUpgrade: false };
  const derived = crypto.scryptSync(pin, salt, 64);
  const storedBuf = Buffer.from(keyHex, 'hex');
  const valid = derived.length === storedBuf.length && crypto.timingSafeEqual(derived, storedBuf);
  return { valid, needsUpgrade: false };
}

// Strict Clerk-only tenant ownership middleware
async function requireVendorOwner(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const clerkUserId = req.auth?.userId;
    if (!clerkUserId) return res.status(401).json({ error: 'Unauthorized' });

    const ownedVendor = await prisma.vendor.findUnique({
      where: { clerkId: clerkUserId },
      select: { id: true, clerkId: true },
    });

    if (!ownedVendor) {
      return res.status(403).json({ error: 'Vendor profile not initialized' });
    }

    const urlVendorId = paramStr(req.params.vendorId);
    if (urlVendorId && urlVendorId !== ownedVendor.id && urlVendorId !== ownedVendor.clerkId) {
      return res.status(403).json({ error: 'Forbidden: vendor ownership mismatch' });
    }

    req.vendorId = ownedVendor.id;
    return next();
  } catch (err) {
    return next(err);
  }
}

// Env-driven CORS (add your new custom domain to ALLOWED_ORIGINS in Render)
const defaultOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  'https://project-r73rm.vercel.app',
];
const envOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
const allowedOrigins = Array.from(new Set([...defaultOrigins, ...envOrigins]));

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error(`CORS blocked origin: ${origin}`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// Keep-alive probe (No auth, no DB)
app.get('/api/health', (_req, res) => {
  res.status(200).json({ ok: true, ts: Date.now() });
});

// Clerk Webhook (MUST stay before express.json() so Svix verifies raw bytes)
app.post(
  '/api/webhooks/clerk',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const WEBHOOK_SECRET = process.env.CLERK_WEBHOOK_SECRET;
    if (!WEBHOOK_SECRET) {
      console.error('Missing CLERK_WEBHOOK_SECRET in .env');
      return res.status(500).json({ error: 'Server configuration error' });
    }

    const svix_id = req.headers['svix-id'] as string;
    const svix_timestamp = req.headers['svix-timestamp'] as string;
    const svix_signature = req.headers['svix-signature'] as string;

    if (!svix_id || !svix_timestamp || !svix_signature) {
      return res.status(400).json({ error: 'Missing Svix headers' });
    }

    const payload = req.body.toString('utf8');
    const wh = new Webhook(WEBHOOK_SECRET);
    let evt: any;

    try {
      evt = wh.verify(payload, {
        'svix-id': svix_id,
        'svix-timestamp': svix_timestamp,
        'svix-signature': svix_signature,
      });
    } catch (err: any) {
      console.error('Webhook verification failed:', err.message);
      return res.status(400).json({ error: 'Verification failed' });
    }

    if (evt.type === 'user.created') {
      const { id, email_addresses } = evt.data;
      const primaryEmail = email_addresses?.[0]?.email_address || `${id}@pending-setup.com`;

      try {
        await prisma.vendor.upsert({
          where: { clerkId: id },
          update: { email: primaryEmail },
          create: { clerkId: id, email: primaryEmail },
        });
        console.log(`Database profile synced for vendor: ${primaryEmail}`);
      } catch (error) {
        console.error('Failed to save new vendor to DB:', error);
      }
    }

    return res.status(200).json({ success: true });
  }
);

app.use(express.json());

// Auto-Seed Default Menu for empty fresh databases
async function seedDatabase() {
  try {
    const itemCount = await prisma.menuItem.count();
    if (itemCount === 0) {
      console.log('No menu items found. Injecting default menu…');
      await prisma.vendor.upsert({
        where: { id: 'spice-street-kitchen' },
        update: {},
        create: {
          id: 'spice-street-kitchen',
          clerkId: 'dummy_clerk_id_123',
          email: 'test@spicestreet.com',
          name: 'Spice Street Kitchen',
          businessType: 'Street Food',
          tier: 1,
        },
      });

      await prisma.menuItem.createMany({
        data: [
          { vendorId: 'spice-street-kitchen', name: 'Pav Bhaji', category: 'Food', price: 80, prep: '10 min', veg: true },
          { vendorId: 'spice-street-kitchen', name: 'Vada Pav', category: 'Snacks', price: 25, prep: '5 min', veg: true },
          { vendorId: 'spice-street-kitchen', name: 'Chicken Wrap', category: 'Non-veg', price: 120, prep: '12 min', veg: false },
          { vendorId: 'spice-street-kitchen', name: 'Cutting Chai', category: 'Drinks', price: 15, prep: '3 min', veg: true },
        ],
      });
    }
  } catch (err) {
    console.warn('Database initialization warning:', err);
  }
}
seedDatabase();

// --- SERVER-SIDE CART & PRICING ENGINE ---

interface VerifiedCartItem {
  menuItemId: string;
  name: string;
  category: string;
  price: number;
  qty: number;
  recipes: Array<{
    inventoryItemId: string;
    quantityUsed: number;
    inventoryItem: { id: string; name: string; unit: string; currentStock: number };
  }>;
}

async function calculateVerifiedCart(
  tx: Pick<PrismaClient, 'menuItem' | 'promo'>,
  dbVendorId: string,
  rawItems: any[],
  promoCode?: string,
  packIt = false
) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw Object.assign(new Error('Cart cannot be empty'), { statusCode: 400 });
  }

  const requested = rawItems.map((i) => ({
    id: i?.menuItemId || i?.id ? String(i.menuItemId || i.id) : null,
    name: i?.name ? String(i.name).trim() : '',
    qty: Math.floor(Number(i?.qty)),
  }));

  if (requested.some((r) => !Number.isFinite(r.qty) || r.qty <= 0 || r.qty > 50)) {
    throw Object.assign(new Error('Invalid item quantity'), { statusCode: 400 });
  }

  const ids = requested.map((r) => r.id).filter((x): x is string => Boolean(x));
  const names = requested.filter((r) => !r.id && r.name).map((r) => r.name);

  const dbItems = await tx.menuItem.findMany({
    where: {
      vendorId: dbVendorId,
      available: true,
      OR: [
        ...(ids.length ? [{ id: { in: ids } }] : []),
        ...(names.length ? [{ name: { in: names, mode: 'insensitive' as const } }] : []),
      ],
    },
    include: {
      recipes: { include: { inventoryItem: true } },
    },
  });

  const verifiedItems: VerifiedCartItem[] = requested.map((reqItem) => {
    const match = reqItem.id
      ? dbItems.find((d) => d.id === reqItem.id)
      : dbItems.find((d) => d.name.toLowerCase() === reqItem.name.toLowerCase());

    if (!match) {
      throw Object.assign(
        new Error(`Item "${reqItem.name || reqItem.id}" is unavailable or invalid`),
        { statusCode: 400 }
      );
    }

    return {
      menuItemId: match.id,
      name: match.name,
      category: match.category,
      price: Number(match.price),
      qty: reqItem.qty,
      recipes: match.recipes.map((r) => ({
        inventoryItemId: r.inventoryItemId,
        quantityUsed: Number(r.quantityUsed),
        inventoryItem: {
          id: r.inventoryItem.id,
          name: r.inventoryItem.name,
          unit: r.inventoryItem.unit,
          currentStock: Number(r.inventoryItem.currentStock),
        },
      })),
    };
  });

  const subtotal = verifiedItems.reduce((sum, item) => sum + item.price * item.qty, 0);
  let discountAmount = 0;
  let appliedPromo: { id: string; maxUses: number | null } | null = null;

  if (promoCode && String(promoCode).trim()) {
    const cleanCode = String(promoCode).trim().toUpperCase();
    const promo = await tx.promo.findFirst({
      where: { vendorId: dbVendorId, code: cleanCode },
    });

    if (!promo || !promo.isActive) {
      throw Object.assign(new Error('Invalid or inactive promo code.'), { statusCode: 400 });
    }
    if (subtotal < promo.minOrderValue) {
      throw Object.assign(new Error(`Cart must be at least ₹${promo.minOrderValue}.`), { statusCode: 400 });
    }
    if (promo.expiresAt && new Date() > promo.expiresAt) {
      throw Object.assign(new Error('This promo code has expired.'), { statusCode: 400 });
    }
    if (promo.maxUses !== null && promo.currentUses >= promo.maxUses) {
      throw Object.assign(new Error('Usage limit reached.'), { statusCode: 400 });
    }

    let eligibleTotal = subtotal;
    if (promo.applyTo !== 'ALL') {
      eligibleTotal = verifiedItems
        .filter((item) => item.category === promo.applyTo || item.name === promo.applyTo)
        .reduce((sum, item) => sum + item.price * item.qty, 0);

      if (eligibleTotal === 0) {
        throw Object.assign(new Error(`This code only applies to ${promo.applyTo}.`), { statusCode: 400 });
      }
    }

    if (promo.type === 'FLAT') {
      discountAmount = Math.min(promo.value, eligibleTotal);
    } else if (promo.type === 'PERCENTAGE' || promo.type === 'Percentage discount (%)') {
      discountAmount = (eligibleTotal * promo.value) / 100;
    }

    discountAmount = Math.round(discountAmount);
    appliedPromo = { id: promo.id, maxUses: promo.maxUses };
  }

  const packingFee = packIt ? PACKING_FEE_INR : 0;
  const finalTotal = Math.max(0, Math.round(subtotal - discountAmount + packingFee));
  return { verifiedItems, subtotal, discountAmount, packingFee, finalTotal, appliedPromo };
}

// --- SETTINGS & PROFILE ROUTES ---

// 1. Authenticated Vendor Bootstrap (Replaces unauthenticated auto-create)
app.get('/api/vendor/me', requireAuth, async (req: AuthedRequest, res) => {
  try {
    const clerkUserId = req.auth?.userId;
    if (!clerkUserId) return res.status(401).json({ error: 'Unauthorized' });

    const vendor = await prisma.vendor.upsert({
      where: { clerkId: clerkUserId },
      update: {},
      create: {
        clerkId: clerkUserId,
        name: 'My Restaurant',
        businessType: 'Street Stall',
        email: `${clerkUserId}@pending-setup.com`,
      },
      select: {
        id: true,
        name: true,
        businessType: true,
        address: true,
        email: true,
        logoUrl: true,
        dashboardLogoUrl: true,
        useLogoAsHeader: true,
        masterPin: true,
      },
    });

    const { masterPin, ...safeVendor } = vendor;
    return res.json({ ...safeVendor, hasMasterPin: Boolean(masterPin) });
  } catch {
    return res.status(500).json({ error: 'Failed to load vendor session' });
  }
});

// 2. Public Storefront Profile (Read-only, public branding fields ONLY — no PIN/email/clerkId)
app.get('/api/vendors/:vendorId/profile', async (req, res) => {
  try {
    const dbVendorId = await getDbVendorId(req.params.vendorId);
    if (!dbVendorId) return res.status(404).json({ error: 'Vendor profile not found' });

    const vendor = await prisma.vendor.findUnique({
      where: { id: dbVendorId },
      select: {
        id: true,
        name: true,
        businessType: true,
        logoUrl: true,
        bannerUrl: true,
        useLogoAsHeader: true,
        accentColor: true,
        themeMode: true,
        fontFamily: true,
        buttonRoundness: true,
        showOfferStrip: true,
        offerText: true,
      },
    });

    if (!vendor) return res.status(404).json({ error: 'Vendor profile not found' });
    return res.json(vendor);
  } catch {
    return res.status(500).json({ error: 'Failed to fetch vendor profile' });
  }
});

// 3. Update Vendor Profile (Owner-Scoped)
app.patch('/api/vendors/:vendorId/profile', requireAuth, requireVendorOwner, async (req: AuthedRequest, res) => {
  try {
    const { name, businessType, address, useLogoAsHeader, logoUrl, dashboardLogoUrl } = req.body;
    const updatedVendor = await prisma.vendor.update({
      where: { id: req.vendorId! },
      data: { name, businessType, address, useLogoAsHeader, logoUrl, dashboardLogoUrl },
      select: {
        id: true,
        name: true,
        businessType: true,
        address: true,
        useLogoAsHeader: true,
        logoUrl: true,
        dashboardLogoUrl: true,
      },
    });
    return res.json(updatedVendor);
  } catch {
    return res.status(500).json({ error: 'Failed to update store profile' });
  }
});

// 4. Set or Update Master PIN (Salted scrypt)
app.post('/api/vendors/:vendorId/pin', requireAuth, requireVendorOwner, async (req: AuthedRequest, res) => {
  try {
    const pin = String(req.body.pin || '');
    if (!/^\d{4}$/.test(pin)) {
      return res.status(400).json({ error: 'PIN must be exactly 4 digits' });
    }
    await prisma.vendor.update({
      where: { id: req.vendorId! },
      data: { masterPin: hashPin(pin) },
    });
    return res.json({ success: true, message: 'Master PIN securely updated' });
  } catch {
    return res.status(500).json({ error: 'Failed to update PIN' });
  }
});

// 5. Verify Master PIN (Owner-Scoped + auto-upgrades legacy plaintext PINs)
app.post('/api/vendors/:vendorId/pin/verify', requireAuth, requireVendorOwner, async (req: AuthedRequest, res) => {
  try {
    const pin = String(req.body.pin || '');
    const vendor = await prisma.vendor.findUnique({
      where: { id: req.vendorId! },
      select: { masterPin: true },
    });
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });
    if (!vendor.masterPin) return res.json({ success: true, isSetupRequired: true });

    const { valid, needsUpgrade } = verifyPin(pin, vendor.masterPin);
    if (!valid) return res.status(401).json({ success: false, error: 'Incorrect PIN' });

    if (needsUpgrade) {
      await prisma.vendor.update({
        where: { id: req.vendorId! },
        data: { masterPin: hashPin(pin) },
      });
    }
    return res.json({ success: true });
  } catch {
    return res.status(500).json({ error: 'Failed to verify PIN' });
  }
});

// --- INVENTORY & DAILY EXPENSES ---

app.post('/api/vendors/:vendorId/expenses', requireAuth, requireVendorOwner, async (req: AuthedRequest, res) => {
  try {
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Expense amount must be a positive number' });
    }
    const newExpense = await prisma.dailyExpense.create({
      data: {
        vendorId: req.vendorId!,
        amount,
        category: req.body.category || 'Raw Materials',
        description: req.body.description || '',
      },
    });
    return res.status(201).json(newExpense);
  } catch {
    return res.status(500).json({ error: 'Failed to log inventory expense' });
  }
});

app.get('/api/vendors/:vendorId/profit/today', requireAuth, requireVendorOwner, async (req: AuthedRequest, res) => {
  try {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [todaysOrders, todaysExpenses] = await Promise.all([
      prisma.order.aggregate({
        where: { vendorId: req.vendorId!, createdAt: { gte: startOfToday }, kitchenStatus: 'completed' },
        _sum: { total: true },
      }),
      prisma.dailyExpense.findMany({
        where: { vendorId: req.vendorId!, date: { gte: startOfToday } },
        orderBy: { date: 'desc' },
      }),
    ]);

    const grossRevenue = todaysOrders._sum.total || 0;
    const totalCost = todaysExpenses.reduce((sum, exp) => sum + exp.amount, 0);
    return res.json({
      success: true,
      grossRevenue,
      totalCost,
      netProfit: grossRevenue - totalCost,
      expensesList: todaysExpenses,
    });
  } catch {
    return res.status(500).json({ error: 'Failed to calculate daily profit' });
  }
});

// --- INVENTORY & RECIPES MANAGEMENT ---

app.get('/api/vendors/:vendorId/inventory', requireAuth, requireVendorOwner, async (req: AuthedRequest, res) => {
  try {
    const items = await prisma.inventoryItem.findMany({
      where: { vendorId: req.vendorId! },
      orderBy: { name: 'asc' },
    });
    return res.json({ items });
  } catch {
    return res.status(500).json({ error: 'Failed to fetch inventory' });
  }
});

app.post('/api/vendors/:vendorId/inventory', requireAuth, requireVendorOwner, async (req: AuthedRequest, res) => {
  try {
    const { name, unit, currentStock, minAlert, costPerUnit, totalPurchaseCost } = req.body;
    const result = await prisma.$transaction(async (tx) => {
      const item = await tx.inventoryItem.create({
        data: {
          vendorId: req.vendorId!,
          name: String(name || '').trim(),
          unit,
          currentStock: Number(currentStock) || 0,
          minAlert: Number(minAlert) || 0,
          costPerUnit: Number(costPerUnit) || 0,
        },
      });

      if (Number(totalPurchaseCost) > 0) {
        await tx.dailyExpense.create({
          data: {
            vendorId: req.vendorId!,
            description: `Initial Stock: ${item.name} (${currentStock} ${unit})`,
            amount: Number(totalPurchaseCost),
            category: 'INVENTORY_PURCHASE',
            date: new Date(),
          },
        });
      }
      return item;
    });
    return res.json({ success: true, item: result });
  } catch {
    return res.status(500).json({ error: 'Failed to register inventory item' });
  }
});

app.post('/api/vendors/:vendorId/menu/:itemId/recipe', requireAuth, requireVendorOwner, async (req: AuthedRequest, res) => {
  try {
    const menuItemId = paramStr(req.params.itemId);
    const ingredients: Array<{ inventoryItemId: string; quantityUsed: number }> =
      Array.isArray(req.body.ingredients) ? req.body.ingredients : [];

    // 1. Verify dish belongs to vendor
    const dish = await prisma.menuItem.findFirst({
      where: { id: menuItemId, vendorId: req.vendorId! },
      select: { id: true },
    });
    if (!dish) return res.status(404).json({ error: 'Menu item not found' });

    // 2. Verify EVERY ingredient belongs to this vendor
    const invIds = [...new Set(ingredients.map((i) => String(i.inventoryItemId)))];
    if (invIds.length > 0) {
      const ownedCount = await prisma.inventoryItem.count({
        where: { id: { in: invIds }, vendorId: req.vendorId! },
      });
      if (ownedCount !== invIds.length) {
        return res.status(403).json({ error: 'One or more ingredients do not belong to your stall' });
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.recipeItem.deleteMany({ where: { menuItemId } });
      if (ingredients.length > 0) {
        await tx.recipeItem.createMany({
          data: ingredients.map((ing) => ({
            menuItemId,
            inventoryItemId: String(ing.inventoryItemId),
            quantityUsed: Number(ing.quantityUsed),
          })),
        });
      }
    });

    return res.json({ success: true, message: 'Recipe configuration saved' });
  } catch {
    return res.status(500).json({ error: 'Failed to link recipe ingredients' });
  }
});

app.get('/api/vendors/:vendorId/menu/:itemId/recipe', requireAuth, requireVendorOwner, async (req: AuthedRequest, res) => {
  try {
    const menuItemId = paramStr(req.params.itemId);
    const dish = await prisma.menuItem.findFirst({
      where: { id: menuItemId, vendorId: req.vendorId! },
      select: { id: true },
    });
    if (!dish) return res.status(404).json({ error: 'Menu item not found' });

    const recipe = await prisma.recipeItem.findMany({
      where: { menuItemId },
      include: { inventoryItem: true },
    });
    return res.json({ recipe });
  } catch {
    return res.status(500).json({ error: 'Failed to fetch recipe configuration' });
  }
});

app.post('/api/vendors/:vendorId/inventory/:itemId/restock', requireAuth, requireVendorOwner, async (req: AuthedRequest, res) => {
  try {
    const itemId = paramStr(req.params.itemId);
    const qty = Number(req.body.quantityToAdd);
    const cost = Number(req.body.totalPurchaseCost);
    if (!Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({ error: 'Invalid quantity' });
    }

    const updatedItem = await prisma.$transaction(async (tx) => {
      const item = await tx.inventoryItem.findFirst({
        where: { id: itemId, vendorId: req.vendorId! },
      });
      if (!item) throw Object.assign(new Error('Ingredient not found'), { statusCode: 404 });

      const newCostPerUnit = cost > 0 ? cost / qty : item.costPerUnit;
      const resUpdate = await tx.inventoryItem.updateMany({
        where: { id: itemId, vendorId: req.vendorId! },
        data: { currentStock: { increment: qty }, costPerUnit: newCostPerUnit },
      });
      if (resUpdate.count !== 1) throw Object.assign(new Error('Ingredient not found'), { statusCode: 404 });

      if (cost > 0) {
        await tx.dailyExpense.create({
          data: {
            vendorId: req.vendorId!,
            amount: cost,
            category: 'Raw Materials',
            description: `Refilled ${qty} ${item.unit} of ${item.name}`,
          },
        });
      }

      const linkedRecipes = await tx.recipeItem.findMany({
        where: { inventoryItemId: itemId },
        select: { menuItemId: true },
      });

      for (const link of linkedRecipes) {
        const fullRecipe = await tx.recipeItem.findMany({
          where: { menuItemId: link.menuItemId },
          include: { inventoryItem: true },
        });
        if (fullRecipe.every((r) => r.inventoryItem.currentStock >= r.quantityUsed)) {
          await tx.menuItem.updateMany({
            where: { id: link.menuItemId, vendorId: req.vendorId! },
            data: { available: true },
          });
        }
      }

      return tx.inventoryItem.findFirst({ where: { id: itemId, vendorId: req.vendorId! } });
    });

    return res.json(updatedItem);
  } catch (error: any) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    return res.status(500).json({ error: 'Failed to refill stock' });
  }
});

// --- PAYMENT DATA ROUTES ---

app.post('/api/vendors/:vendorId/payment', requireAuth, requireVendorOwner, async (req: AuthedRequest, res) => {
  try {
    const { paymentType, upiId, qrImagePath, razorpayKeyId, razorpayKeySecret, isActive } = req.body;
    const trimmedSecret = typeof razorpayKeySecret === 'string' ? razorpayKeySecret.trim() : '';
    const secureSecret = trimmedSecret ? encrypt(trimmedSecret) : undefined;
    const secureUpi = upiId ? encrypt(String(upiId).trim()) : '';

    await prisma.paymentData.upsert({
      where: { vendorId: req.vendorId! },
      update: {
        paymentType,
        upiId: secureUpi,
        qrImagePath,
        razorpayKeyId,
        ...(secureSecret ? { razorpayKeySecret: secureSecret } : {}),
        isActive,
      },
      create: {
        vendorId: req.vendorId!,
        paymentType: paymentType || 'UPI',
        upiId: secureUpi,
        qrImagePath: qrImagePath || '',
        razorpayKeyId: razorpayKeyId || '',
        razorpayKeySecret: secureSecret || '',
        isActive: isActive ?? true,
      },
    });
    return res.json({ success: true });
  } catch {
    return res.status(500).json({ error: 'Failed to save payment data' });
  }
});

app.get('/api/vendors/:vendorId/payment', requireAuth, requireVendorOwner, async (req: AuthedRequest, res) => {
  try {
    const paymentData = await prisma.paymentData.findUnique({
      where: { vendorId: req.vendorId! },
    });
    if (!paymentData) return res.status(404).json({ error: 'Payment data not found' });

    return res.json({
      paymentType: paymentData.paymentType,
      upiId: safeDecrypt(paymentData.upiId),
      qrImagePath: paymentData.qrImagePath,
      razorpayKeyId: paymentData.razorpayKeyId,
      hasRazorpaySecret: Boolean(paymentData.razorpayKeySecret),
      isActive: paymentData.isActive,
    });
  } catch {
    return res.status(500).json({ error: 'Failed to fetch payment data' });
  }
});

// Public: Create Razorpay Order (DB-computed amount including promo & ₹10 packing fee)
app.post('/api/checkout/razorpay', async (req, res) => {
  try {
    const { vendorId, items, promoCode, packIt } = req.body;
    if (!vendorId || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'vendorId and cart items are required' });
    }

    const dbVendorId = await getDbVendorId(vendorId);
    if (!dbVendorId) return res.status(404).json({ error: 'Vendor not found' });

    const { finalTotal } = await calculateVerifiedCart(
      prisma,
      dbVendorId,
      items,
      promoCode,
      Boolean(packIt)
    );
    if (finalTotal <= 0) {
      return res.status(400).json({ error: 'Order total must be greater than ₹0 for Razorpay' });
    }

    const paymentData = await prisma.paymentData.findUnique({
      where: { vendorId: dbVendorId },
    });
    if (!paymentData || !paymentData.razorpayKeyId || !paymentData.razorpayKeySecret) {
      return res.status(400).json({ error: 'Restaurant has not configured Razorpay correctly.' });
    }

    const razorpay = new Razorpay({
      key_id: paymentData.razorpayKeyId,
      key_secret: decrypt(paymentData.razorpayKeySecret),
    });

    const order = await razorpay.orders.create({
      amount: Math.round(finalTotal * 100),
      currency: 'INR',
      receipt: `rcpt_${dbVendorId.slice(0, 8)}_${Date.now()}`,
    });

    return res.json({ ...order, verifiedTotal: finalTotal });
  } catch (error: any) {
    if (error.statusCode === 400) return res.status(400).json({ error: error.message });
    return res.status(500).json({ error: 'Failed to create Razorpay order' });
  }
});

// Public: Payment Config for Customer Checkout
app.get('/api/vendors/:vendorId/payment/public', async (req, res) => {
  try {
    const dbVendorId = await getDbVendorId(req.params.vendorId);
    if (!dbVendorId) return res.status(404).json({ error: 'Vendor not found' });

    const paymentConfig = await prisma.paymentData.findUnique({
      where: { vendorId: dbVendorId },
    });

    if (!paymentConfig || !paymentConfig.isActive) {
      return res.json({ available: false });
    }

    return res.json({
      available: true,
      paymentType: paymentConfig.paymentType,
      upiId: safeDecrypt(paymentConfig.upiId),
      qrImagePath: paymentConfig.qrImagePath,
      razorpayKeyId: paymentConfig.razorpayKeyId,
    });
  } catch {
    return res.status(500).json({ error: 'Failed to retrieve public payment data' });
  }
});

// --- MENU ROUTES ---

// Public: Customer Menu
app.get('/api/vendors/:vendorId/menu', async (req, res) => {
  try {
    const dbVendorId = await getDbVendorId(req.params.vendorId);
    if (!dbVendorId) return res.status(404).json({ error: 'Vendor not found' });

    const items = await prisma.menuItem.findMany({
      where: { vendorId: dbVendorId },
      orderBy: [{ available: 'desc' }, { name: 'asc' }],
    });
    return res.json({ items });
  } catch {
    return res.status(500).json({ error: 'Failed to fetch menu' });
  }
});

// Owner-Scoped: Menu Editor CRUD
app.get('/api/vendors/:vendorId/menu-editor', requireAuth, requireVendorOwner, async (req: AuthedRequest, res) => {
  try {
    const items = await prisma.menuItem.findMany({
      where: { vendorId: req.vendorId! },
      orderBy: { category: 'asc' },
    });
    return res.json({ items });
  } catch {
    return res.status(500).json({ error: 'Failed to fetch editor menu' });
  }
});

app.post('/api/vendors/:vendorId/menu', requireAuth, requireVendorOwner, async (req: AuthedRequest, res) => {
  try {
    const newItem = await prisma.menuItem.create({
      data: {
        name: req.body.name,
        category: req.body.category,
        price: Number(req.body.price),
        prep: req.body.prep,
        veg: Boolean(req.body.veg),
        available: req.body.available ?? true,
        imageUrl: req.body.imageUrl || null,
        description: req.body.description || null,
        costPrice: req.body.costPrice ? Number(req.body.costPrice) : null,
        emoji: req.body.emoji || null,
        remarks: req.body.remarks || null,
        badgeLabel: req.body.badgeLabel || null,
        vendorId: req.vendorId!,
      },
    });
    return res.status(201).json(newItem);
  } catch {
    return res.status(500).json({ error: 'Failed to save menu item' });
  }
});

app.patch('/api/vendors/:vendorId/menu/:itemId', requireAuth, requireVendorOwner, async (req: AuthedRequest, res) => {
  try {
    const itemId = paramStr(req.params.itemId);
    const {
      name, category, price, prep, veg, available,
      imageUrl, description, costPrice, emoji, remarks, badgeLabel,
    } = req.body;

    const updateData: Record<string, any> = {};
    if (name !== undefined) updateData.name = name;
    if (category !== undefined) updateData.category = category;
    if (price !== undefined) updateData.price = Number(price);
    if (prep !== undefined) updateData.prep = prep;
    if (veg !== undefined) updateData.veg = Boolean(veg);
    if (available !== undefined) updateData.available = Boolean(available);
    if (imageUrl !== undefined) updateData.imageUrl = imageUrl || null;
    if (description !== undefined) updateData.description = description || null;
    if (costPrice !== undefined) updateData.costPrice = costPrice ? Number(costPrice) : null;
    if (emoji !== undefined) updateData.emoji = emoji || null;
    if (remarks !== undefined) updateData.remarks = remarks || null;
    if (badgeLabel !== undefined) updateData.badgeLabel = badgeLabel || null;

    const result = await prisma.menuItem.updateMany({
      where: { id: itemId, vendorId: req.vendorId! },
      data: updateData,
    });
    if (result.count !== 1) return res.status(404).json({ error: 'Menu item not found' });

    const updatedItem = await prisma.menuItem.findFirst({
      where: { id: itemId, vendorId: req.vendorId! },
    });
    return res.json(updatedItem);
  } catch {
    return res.status(500).json({ error: 'Failed to update item' });
  }
});

app.delete('/api/vendors/:vendorId/menu/:itemId', requireAuth, requireVendorOwner, async (req: AuthedRequest, res) => {
  try {
    const result = await prisma.menuItem.deleteMany({
      where: { id: paramStr(req.params.itemId), vendorId: req.vendorId! },
    });
    if (result.count !== 1) return res.status(404).json({ error: 'Menu item not found' });
    return res.json({ success: true });
  } catch {
    return res.status(500).json({ error: 'Failed to delete item' });
  }
});

// --- OFFERS & PROMOS ROUTES ---

// Public: Active Promos
app.get('/api/vendors/:vendorId/promos', async (req, res) => {
  try {
    const dbVendorId = await getDbVendorId(req.params.vendorId);
    if (!dbVendorId) return res.status(404).json({ error: 'Vendor not found' });

    const now = new Date();
    const promos = await prisma.promo.findMany({
      where: {
        vendorId: dbVendorId,
        isActive: true,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ promos });
  } catch {
    return res.status(500).json({ error: 'Failed to fetch promos' });
  }
});

// Owner-Scoped: Create or Update Promo
app.post('/api/vendors/:vendorId/promos', requireAuth, requireVendorOwner, async (req: AuthedRequest, res) => {
  try {
    const { code, type, value, minOrderValue, maxUses, expiresAt, applyTo } = req.body;
    const cleanCode = String(code || '').trim().toUpperCase();
    if (!cleanCode) return res.status(400).json({ error: 'Promo code is required' });

    const savedPromo = await prisma.promo.upsert({
      where: {
        vendorId_code: { vendorId: req.vendorId!, code: cleanCode },
      },
      update: {
        type,
        value: Number(value),
        minOrderValue: Number(minOrderValue || 0),
        maxUses: maxUses ? Number(maxUses) : null,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        isActive: true,
        applyTo: applyTo || 'ALL',
      },
      create: {
        vendorId: req.vendorId!,
        code: cleanCode,
        type,
        value: Number(value),
        minOrderValue: Number(minOrderValue || 0),
        maxUses: maxUses ? Number(maxUses) : null,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        isActive: true,
        applyTo: applyTo || 'ALL',
      },
    });
    return res.json(savedPromo);
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to save promo' });
  }
});

// Owner-Scoped: Delete Promo
app.delete('/api/vendors/:vendorId/promos/:promoId', requireAuth, requireVendorOwner, async (req: AuthedRequest, res) => {
  try {
    const result = await prisma.promo.deleteMany({
      where: { id: paramStr(req.params.promoId), vendorId: req.vendorId! },
    });
    if (result.count !== 1) return res.status(404).json({ error: 'Promo not found' });
    return res.json({ success: true });
  } catch {
    return res.status(500).json({ error: 'Failed to delete promo' });
  }
});

// Public: Verify Promo at Checkout (Server DB prices only)
app.post('/api/vendors/:vendorId/promos/verify', async (req, res) => {
  try {
    const dbVendorId = await getDbVendorId(req.params.vendorId);
    if (!dbVendorId) return res.status(404).json({ error: 'Vendor not found' });

    const { code, cartItems } = req.body;
    const { discountAmount, finalTotal, appliedPromo } = await calculateVerifiedCart(
      prisma,
      dbVendorId,
      cartItems,
      code,
      false
    );

    return res.json({
      success: true,
      promoId: appliedPromo?.id || null,
      discountAmount,
      newTotal: finalTotal,
    });
  } catch (error: any) {
    if (error.statusCode === 400) return res.status(400).json({ error: error.message });
    return res.status(500).json({ error: 'Failed to verify promo.' });
  }
});

// --- ANALYTICS & SALES ROUTES (Owner-Scoped) ---

app.get('/api/vendors/:vendorId/analytics', requireAuth, requireVendorOwner, async (req: AuthedRequest, res) => {
  try {
    const today = new Date();
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(today.getDate() - 30);

    const orders = await prisma.order.findMany({
      where: {
        vendorId: req.vendorId!,
        createdAt: { gte: thirtyDaysAgo },
        kitchenStatus: 'completed',
      },
      include: { items: true },
    });

    const totalOrders = orders.length;
    let totalRevenue = 0;
    let upi = 0, cash = 0, card = 0;

    orders.forEach((o) => {
      totalRevenue += o.total;
      if (o.paymentMode === 'UPI' || o.paymentMode === 'RAZORPAY') upi++;
      else if (o.paymentMode === 'CASH') cash++;
      else card++;
    });

    const avgOrder = totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0;
    const calcPercent = (val: number) => (totalOrders > 0 ? Math.round((val / totalOrders) * 100) : 0);

    const itemTracker: Record<string, any> = {};
    orders.forEach((order) => {
      (order.items || []).forEach((item) => {
        if (!itemTracker[item.name]) {
          itemTracker[item.name] = { id: item.id, name: item.name, rev: 0, sold: 0 };
        }
        itemTracker[item.name].rev += item.price * item.qty;
        itemTracker[item.name].sold += item.qty;
      });
    });

    const topItems = Object.values(itemTracker)
      .sort((a: any, b: any) => b.rev - a.rev)
      .slice(0, 5)
      .map((item: any) => ({ ...item, rev: item.rev.toLocaleString('en-IN') }));

    const dailyRevenue = new Array(30).fill(0);
    orders.forEach((order) => {
      const diffTime = Math.abs(today.getTime() - new Date(order.createdAt).getTime());
      const daysAgo = Math.floor(diffTime / (1000 * 60 * 60 * 24));
      if (daysAgo < 30) dailyRevenue[29 - daysAgo] += order.total;
    });

    const maxDaily = Math.max(...dailyRevenue, 1);
    const trend = dailyRevenue.map((rev) => Math.round((rev / maxDaily) * 100));

    const hourBuckets = { morning: 0, lunch: 0, evening: 0, night: 0 };
    orders.forEach((order) => {
      const hour = new Date(order.createdAt).getHours();
      if (hour >= 9 && hour < 12) hourBuckets.morning++;
      else if (hour >= 12 && hour < 15) hourBuckets.lunch++;
      else if (hour >= 17 && hour < 20) hourBuckets.evening++;
      else if (hour >= 20 && hour < 23) hourBuckets.night++;
    });

    const maxHour = Math.max(hourBuckets.morning, hourBuckets.lunch, hourBuckets.evening, hourBuckets.night, 1);
    const peakPercent = (val: number) => Math.round((val / maxHour) * 100);

    const peakHours = [
      { label: '6–8 PM', percentage: peakPercent(hourBuckets.evening) },
      { label: '8–10 PM', percentage: peakPercent(hourBuckets.night) },
      { label: '12–2 PM', percentage: peakPercent(hourBuckets.lunch) },
      { label: '9–11 AM', percentage: peakPercent(hourBuckets.morning) },
    ];

    return res.json({
      revenue: totalRevenue.toLocaleString('en-IN'),
      orders: totalOrders,
      avgOrder,
      rating: 4.8,
      paymentSplit: [
        { label: 'UPI / QR', percentage: calcPercent(upi), color: 'bg-blue-500' },
        { label: 'Cash', percentage: calcPercent(cash), color: 'bg-[#E5B35C]' },
        { label: 'Card', percentage: calcPercent(card), color: 'bg-gray-500' },
      ],
      peakHours,
      topItems,
      trend,
    });
  } catch {
    return res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

app.get('/api/vendors/:vendorId/sales', requireAuth, requireVendorOwner, async (req: AuthedRequest, res) => {
  try {
    const requestedDays = Number(req.query.days);
    const days =
      Number.isFinite(requestedDays) && requestedDays > 0
        ? Math.min(Math.floor(requestedDays), 90)
        : 30;

    const since = new Date(Date.now() - (days + 1) * 86400000);

    const orders = await prisma.order.findMany({
      where: {
        vendorId: req.vendorId!,
        kitchenStatus: 'completed',
        createdAt: { gte: since },
      },
      select: {
        id: true,
        token: true,
        total: true,
        paymentMode: true,
        kitchenStatus: true,
        customerName: true,
        customerPhone: true,
        tableId: true,
        createdAt: true,
        items: {
          select: { name: true, qty: true, price: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({ orders });
  } catch {
    return res.status(500).json({ error: 'Failed to fetch sales data' });
  }
});

// --- ORDER & CHECKOUT ENGINE ---

// Public: Create Order (Server DB Pricing + Razorpay HMAC/API/Replay Verification + Atomic Auto-86)
app.post('/api/orders', async (req, res) => {
  try {
    const {
      vendorId,
      tableId,
      customerName,
      customerPhone,
      items,
      paymentMode,
      promoCode,
      packIt,
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature,
    } = req.body;

    const dbVendorId = await getDbVendorId(vendorId);
    if (!dbVendorId) return res.status(404).json({ error: 'Vendor not found' });

    const normalizedMode = String(paymentMode || 'CASH').trim().toUpperCase();
    const allowedModes = ['CASH', 'UPI', 'RAZORPAY', 'ONLINE', 'CARD'];
    if (!allowedModes.includes(normalizedMode)) {
      return res.status(400).json({ error: 'Unsupported payment mode' });
    }

    const isParcel = Boolean(packIt);
    const preCheck = await calculateVerifiedCart(prisma, dbVendorId, items, promoCode, isParcel);
    const paymentConfig = await prisma.paymentData.findUnique({
      where: { vendorId: dbVendorId },
    });

    const requiresRazorpayProof =
      normalizedMode === 'RAZORPAY' ||
      normalizedMode === 'ONLINE' ||
      Boolean(razorpayPaymentId) ||
      (normalizedMode !== 'CASH' &&
        paymentConfig?.isActive &&
        paymentConfig.paymentType?.toUpperCase() === 'RAZORPAY');

    let verifiedRzpOrderId: string | null = null;
    let verifiedRzpPaymentId: string | null = null;

    if (requiresRazorpayProof) {
      if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
        return res.status(400).json({ error: 'Missing Razorpay payment verification proof' });
      }
      if (!paymentConfig?.razorpayKeyId || !paymentConfig?.razorpayKeySecret) {
        return res.status(400).json({ error: 'Vendor Razorpay credentials are not configured' });
      }

      const secret = decrypt(paymentConfig.razorpayKeySecret);
      const expectedSig = crypto
        .createHmac('sha256', secret)
        .update(`${razorpayOrderId}|${razorpayPaymentId}`)
        .digest('hex');

      const sigBuf = Buffer.from(String(razorpaySignature), 'utf8');
      const expBuf = Buffer.from(expectedSig, 'utf8');
      if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        return res.status(400).json({ error: 'Invalid Razorpay payment signature' });
      }

      const razorpay = new Razorpay({
        key_id: paymentConfig.razorpayKeyId,
        key_secret: secret,
      });
      const payment: any = await razorpay.payments.fetch(String(razorpayPaymentId));
      const expectedPaise = Math.round(preCheck.finalTotal * 100);

      if (
        payment.order_id !== String(razorpayOrderId) ||
        Number(payment.amount) !== expectedPaise ||
        !['captured', 'authorized'].includes(String(payment.status))
      ) {
        return res.status(400).json({ error: 'Razorpay payment amount or status mismatch' });
      }

      verifiedRzpOrderId = String(razorpayOrderId);
      verifiedRzpPaymentId = String(razorpayPaymentId);
    }

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const newOrder = await prisma.$transaction(async (tx) => {
      const { verifiedItems, finalTotal, appliedPromo } = await calculateVerifiedCart(
        tx,
        dbVendorId,
        items,
        promoCode,
        isParcel
      );

      if (verifiedRzpPaymentId && finalTotal !== preCheck.finalTotal) {
        throw Object.assign(new Error('Menu prices changed during checkout. Please retry.'), {
          statusCode: 409,
        });
      }

      if (appliedPromo) {
        const promoUpdate = await tx.promo.updateMany({
          where: {
            id: appliedPromo.id,
            vendorId: dbVendorId,
            isActive: true,
            ...(appliedPromo.maxUses !== null
              ? { currentUses: { lt: appliedPromo.maxUses } }
              : {}),
          },
          data: { currentUses: { increment: 1 } },
        });
        if (promoUpdate.count !== 1) {
          throw Object.assign(new Error('Promo code usage limit was just reached.'), { statusCode: 400 });
        }
      }

      const ingredientDemand = new Map<
        string,
        { item: { id: string; name: string; unit: string; currentStock: number }; totalNeeded: number; dishNames: string[] }
      >();

      for (const dish of verifiedItems) {
        for (const recipe of dish.recipes) {
          const qtyUsed = recipe.quantityUsed * dish.qty;
          const existing = ingredientDemand.get(recipe.inventoryItemId);
          if (existing) {
            existing.totalNeeded += qtyUsed;
            existing.dishNames.push(dish.name);
          } else {
            ingredientDemand.set(recipe.inventoryItemId, {
              item: recipe.inventoryItem,
              totalNeeded: qtyUsed,
              dishNames: [dish.name],
            });
          }
        }
      }

      for (const [, demand] of ingredientDemand.entries()) {
        if (demand.item.currentStock < demand.totalNeeded) {
          throw Object.assign(
            new Error(
              `Insufficient stock for "${demand.item.name}". Required: ${demand.totalNeeded} ${demand.item.unit}, Available: ${demand.item.currentStock} ${demand.item.unit}.`
            ),
            { statusCode: 400 }
          );
        }
      }

      const lastOrder = await tx.order.findFirst({
        where: { vendorId: dbVendorId, createdAt: { gte: startOfToday } },
        orderBy: { token: 'desc' },
      });
      const nextToken = lastOrder?.token ? lastOrder.token + 1 : 1;

      const createdOrder = await tx.order.create({
        data: {
          vendorId: dbVendorId,
          token: nextToken,
          customerName: String(customerName || 'Counter Order').slice(0, 120),
          customerPhone: String(customerPhone || '0000000000').slice(0, 20),
          paymentMode: normalizedMode,
          tableId: String(tableId || 'Counter').slice(0, 40),
          total: finalTotal,
          kitchenStatus: 'pending',
          razorpayOrderId: verifiedRzpOrderId,
          razorpayPaymentId: verifiedRzpPaymentId,
          items: {
            create: verifiedItems.map((item) => ({
              name: item.name,
              qty: item.qty,
              price: item.price,
            })),
          },
        },
      });

      for (const [inventoryId, demand] of ingredientDemand.entries()) {
        const updatedStock = await tx.inventoryItem.update({
          where: { id: inventoryId },
          data: { currentStock: { decrement: demand.totalNeeded } },
        });

        const dependentRecipes = await tx.recipeItem.findMany({
          where: { inventoryItemId: updatedStock.id },
          select: { menuItemId: true, quantityUsed: true },
        });

        const dishIdsToDisable = dependentRecipes
          .filter((r) => updatedStock.currentStock < r.quantityUsed)
          .map((r) => r.menuItemId);

        if (dishIdsToDisable.length > 0) {
          await tx.menuItem.updateMany({
            where: { id: { in: dishIdsToDisable }, vendorId: dbVendorId },
            data: { available: false },
          });
        }
      }

      return createdOrder;
    });

    return res.status(201).json({
      id: newOrder.id,
      tokenNumber: newOrder.token.toString(),
      total: newOrder.total,
    });
  } catch (error: any) {
    if (error?.code === 'P2002') {
      return res.status(409).json({ error: 'This payment has already been used for an order.' });
    }
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Failed to create order' });
  }
});

// Owner-Scoped: Active Kitchen Queue
app.get('/api/vendors/:vendorId/kitchen-queue', requireAuth, requireVendorOwner, async (req: AuthedRequest, res) => {
  try {
    const orders = await prisma.order.findMany({
      where: {
        vendorId: req.vendorId!,
        kitchenStatus: { notIn: ['completed', 'cancelled', 'rejected'] },
      },
      include: { items: true },
      orderBy: { createdAt: 'asc' },
    });
    return res.json({ orders });
  } catch {
    return res.status(500).json({ error: 'Failed to fetch queue' });
  }
});

// Owner-Scoped: Atomic Kitchen Status Update (Prevents double-restock on cancel)
app.patch('/api/orders/:orderId/kitchen-status', requireAuth, requireVendorOwner, async (req: AuthedRequest, res) => {
  const orderId = paramStr(req.params.orderId);
  const status = String(req.body.status || '').toLowerCase();
  const validStatuses = ['pending', 'preparing', 'ready', 'completed', 'cancelled', 'rejected'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid kitchen status' });
  }

  try {
    const updatedOrder = await prisma.$transaction(async (tx) => {
      const existingOrder = await tx.order.findFirst({
        where: { id: orderId, vendorId: req.vendorId! },
        include: { items: true },
      });
      if (!existingOrder) throw Object.assign(new Error('Order not found'), { statusCode: 404 });

      const isCancelRequest = status === 'cancelled' || status === 'rejected';

      if (isCancelRequest) {
        const cancelGate = await tx.order.updateMany({
          where: {
            id: orderId,
            vendorId: req.vendorId!,
            kitchenStatus: { notIn: ['cancelled', 'rejected'] },
          },
          data: { kitchenStatus: status, status },
        });

        if (cancelGate.count === 1) {
          const affectedMenuItemIds = new Set<string>();

          for (const orderItem of existingOrder.items) {
            const menuItem = await tx.menuItem.findFirst({
              where: {
                vendorId: req.vendorId!,
                name: { equals: orderItem.name.trim(), mode: 'insensitive' },
              },
              include: { recipes: true },
            });

            if (menuItem && menuItem.recipes.length > 0) {
              affectedMenuItemIds.add(menuItem.id);
              for (const recipe of menuItem.recipes) {
                const restoreQty = Number(recipe.quantityUsed) * Number(orderItem.qty);
                await tx.inventoryItem.updateMany({
                  where: { id: recipe.inventoryItemId, vendorId: req.vendorId! },
                  data: { currentStock: { increment: restoreQty } },
                });
              }
            }
          }

          for (const menuItemId of affectedMenuItemIds) {
            const fullRecipe = await tx.recipeItem.findMany({
              where: { menuItemId },
              include: { inventoryItem: true },
            });
            if (fullRecipe.every((r) => r.inventoryItem.currentStock >= r.quantityUsed)) {
              await tx.menuItem.updateMany({
                where: { id: menuItemId, vendorId: req.vendorId! },
                data: { available: true },
              });
            }
          }
        }
      } else {
        const result = await tx.order.updateMany({
          where: { id: orderId, vendorId: req.vendorId! },
          data: { kitchenStatus: status, status },
        });
        if (result.count !== 1) throw Object.assign(new Error('Order not found'), { statusCode: 404 });
      }

      return tx.order.findFirst({
        where: { id: orderId, vendorId: req.vendorId! },
        include: { items: true },
      });
    });

    return res.json(updatedOrder);
  } catch (error: any) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    return res.status(500).json({ error: 'Failed to update status' });
  }
});

// Public: Single Order Status (Customer Live Tracker)
app.get('/api/orders/:orderId/status', async (req, res) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: paramStr(req.params.orderId) },
      select: { id: true, token: true, kitchenStatus: true, status: true },
    });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    return res.json(order);
  } catch {
    return res.status(500).json({ error: 'Failed to fetch status' });
  }
});

// Dev-only Mock OTP (Disabled automatically in production)
if (process.env.NODE_ENV !== 'production') {
  app.post('/api/otp/send', (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone number is required' });
    let formattedPhone = String(phone).replace(/\D/g, '');
    if (formattedPhone.length === 10) formattedPhone = `91${formattedPhone}`;
    return res.json({ sent: true, phone: formattedPhone });
  });

  app.post('/api/otp/verify', (req, res) => {
    const { phone, otp } = req.body;
    if (!phone || !otp) return res.status(400).json({ error: 'Phone number and OTP are both required' });
    const formattedPhone = String(phone).replace(/\D/g, '');
    if (otp === '1234' || otp === '123456') {
      return res.json({ verified: true, phone: formattedPhone });
    }
    return res.status(400).json({ error: 'Invalid mock OTP code. Please use 1234.' });
  });
}

// --- BRANDING STUDIO ROUTES (Owner-Scoped) ---

app.get('/api/vendors/:vendorId/branding', requireAuth, requireVendorOwner, async (req: AuthedRequest, res) => {
  try {
    const vendor = await prisma.vendor.findUnique({
      where: { id: req.vendorId! },
      select: {
        name: true,
        themeMode: true,
        accentColor: true,
        fontFamily: true,
        buttonRoundness: true,
        logoUrl: true,
        bannerUrl: true,
        showOfferStrip: true,
        offerText: true,
      },
    });
    if (!vendor) return res.status(404).json({ error: 'Vendor profile not found' });

    return res.status(200).json({
      storeName: vendor.name || 'Your Store',
      branding: {
        themeMode: vendor.themeMode || 'dark',
        accentColor: vendor.accentColor || '#E5B35C',
        fontFamily: vendor.fontFamily || 'font-sans',
        buttonRoundness: vendor.buttonRoundness || 'rounded-xl',
        logoUrl: vendor.logoUrl,
        bannerUrl: vendor.bannerUrl,
        showOfferStrip: vendor.showOfferStrip,
        offerText: vendor.offerText,
      },
    });
  } catch {
    return res.status(500).json({ error: 'Internal server failure' });
  }
});

app.patch('/api/vendors/:vendorId/branding', requireAuth, requireVendorOwner, async (req: AuthedRequest, res) => {
  try {
    const {
      themeMode, accentColor, fontFamily, buttonRoundness,
      logoUrl, bannerUrl, showOfferStrip, offerText,
    } = req.body;

    const updatedVendor = await prisma.vendor.update({
      where: { id: req.vendorId! },
      data: {
        themeMode,
        accentColor,
        fontFamily,
        buttonRoundness,
        showOfferStrip,
        offerText,
        ...(logoUrl && { logoUrl }),
        ...(bannerUrl && { bannerUrl }),
      },
      select: {
        themeMode: true,
        accentColor: true,
        fontFamily: true,
        buttonRoundness: true,
        showOfferStrip: true,
        offerText: true,
        logoUrl: true,
        bannerUrl: true,
      },
    });

    return res.status(200).json({ success: true, branding: updatedVendor });
  } catch {
    return res.status(500).json({ error: 'Failed to update branding settings' });
  }
});

// --- GLOBAL ERROR CATCHER ---
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Server Error:', err.message || err);
  if (err.message === 'Unauthenticated' || String(err.message || '').includes('token')) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or expired session token' });
  }
  return res.status(500).json({ error: 'Internal Server Error', details: err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Pabee Backend running on port ${PORT}`));