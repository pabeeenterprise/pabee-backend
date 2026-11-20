import { encrypt, decrypt } from './utils/encryption';
import express from 'express';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';
import { Webhook } from 'svix';
import { ClerkExpressRequireAuth } from '@clerk/clerk-sdk-node';
import Razorpay from 'razorpay';

const prisma = new PrismaClient();
const app = express();
const requireAuth = ClerkExpressRequireAuth({}) as unknown as express.RequestHandler;

// Helper: Safely resolve Clerk ID (user_...) to Postgres Database UUID
async function getDbVendorId(idParam: string | string[] | undefined): Promise<string | null> {
  if (!idParam) return null;
  const cleanId = Array.isArray(idParam) ? idParam[0] : idParam;
  if (cleanId.startsWith('user_')) {
    const vendor = await prisma.vendor.findUnique({ where: { clerkId: cleanId } });
    return vendor ? vendor.id : null;
  }
  return cleanId;
}

app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://localhost:3000',
    'https://project-r73rm.vercel.app'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Keep-alive probe. No auth, no database — safe for an external pinger.
app.get('/api/health', (_req, res) => {
  res.status(200).json({ ok: true, ts: Date.now() });
});

// Clerk Webhook (New user registration)
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
      const primaryEmail = email_addresses[0].email_address;

      try {
        await prisma.vendor.create({
          data: {
            clerkId: id,
            email: primaryEmail,
          },
        });
        console.log(`✅ Database profile created for vendor: ${primaryEmail}`);
      } catch (error) {
        console.error('🔥 Failed to save new vendor to DB:', error);
      }
    }

    return res.status(200).json({ success: true });
  }
);

app.use(express.json());

// Auto-Seed Default Menu for Demonstration
async function seedDatabase() {
  try {
    const itemCount = await prisma.menuItem.count();
    
    if (itemCount === 0) {
      console.log('🌱 No menu items found. Injecting default menu…');
      
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
        }
      });

      await prisma.menuItem.createMany({
        data: [
          { vendorId: 'spice-street-kitchen', name: 'Pav Bhaji', category: 'Food', price: 80, prep: '10 min', veg: true },
          { vendorId: 'spice-street-kitchen', name: 'Vada Pav', category: 'Snacks', price: 25, prep: '5 min', veg: true },
          { vendorId: 'spice-street-kitchen', name: 'Chicken Wrap', category: 'Non-veg', price: 120, prep: '12 min', veg: false },
          { vendorId: 'spice-street-kitchen', name: 'Cutting Chai', category: 'Drinks', price: 15, prep: '3 min', veg: true }
        ]
      });
      console.log('✅ Menu items successfully injected!');
    }
  } catch (err) {
    console.warn('Database initialization warning:', err);
  }
}
seedDatabase();

// --- ⚙️ SETTINGS & PROFILE ROUTES ---

// 1. Get Vendor Profile
app.get('/api/vendors/:vendorId/profile', async (req, res) => {
  try {
    let vendor = await prisma.vendor.findFirst({
      where: {
        OR: [
          { clerkId: req.params.vendorId },
          { id: req.params.vendorId }
        ]
      }
    });
    
    if (!vendor && req.params.vendorId.startsWith('user_')) {
      vendor = await prisma.vendor.create({
        data: {
          clerkId: req.params.vendorId,
          name: 'My Restaurant', 
          businessType: 'Street Stall',
          email: `${req.params.vendorId}@pending-setup.com` 
        }
      });
    }

    if (!vendor) return res.status(404).json({ error: 'Vendor profile not found' });
    res.json(vendor);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch vendor profile' });
  }
});

// 2. Update Vendor Profile
app.patch('/api/vendors/:vendorId/profile', requireAuth, async (req, res) => {
  try {
    const { name, businessType, address, useLogoAsHeader, logoUrl, dashboardLogoUrl } = req.body;
    const dbVendorId = await getDbVendorId(req.params.vendorId);
    if (!dbVendorId) return res.status(404).json({ error: 'Vendor not found' });

    const updatedVendor = await prisma.vendor.update({
      where: { id: dbVendorId },
      data: { name, businessType, address, useLogoAsHeader, logoUrl, dashboardLogoUrl }
    });

    res.json(updatedVendor);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update store profile' });
  }
});

// 3. Set or Update Master PIN
app.post('/api/vendors/:vendorId/pin', requireAuth, async (req, res) => {
  try {
    const { pin } = req.body;
    if (!pin || !/^\d{4}$/.test(pin)) {
      return res.status(400).json({ error: 'PIN must be exactly 4 digits' });
    }

    const dbVendorId = await getDbVendorId(req.params.vendorId);
    if (!dbVendorId) return res.status(404).json({ error: 'Vendor not found' });

    await prisma.vendor.update({
      where: { id: dbVendorId },
      data: { masterPin: pin }
    });

    res.json({ success: true, message: 'Master PIN securely updated' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update PIN' });
  }
});

// 4. Verify Master PIN
app.post('/api/vendors/:vendorId/pin/verify', async (req, res) => {
  try {
    const { pin } = req.body;
    const dbVendorId = await getDbVendorId(req.params.vendorId);
    if (!dbVendorId) return res.status(404).json({ error: 'Vendor not found' });

    const vendor = await prisma.vendor.findUnique({ where: { id: dbVendorId } });
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });

    if (!vendor.masterPin) {
      return res.json({ success: true, isSetupRequired: true }); 
    }

    if (vendor.masterPin === pin) {
      return res.json({ success: true });
    } else {
      return res.status(401).json({ success: false, error: 'Incorrect PIN' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to verify PIN' });
  }
});

// --- 💰 INVENTORY & DAILY EXPENSES ---

// 1. Log New Purchase (Money Out)
app.post('/api/vendors/:vendorId/expenses', async (req, res) => {
  try {
    const { amount, category, description } = req.body;
    const dbVendorId = await getDbVendorId(req.params.vendorId);
    if (!dbVendorId) return res.status(404).json({ error: 'Vendor not found' });

    const newExpense = await prisma.dailyExpense.create({
      data: {
        vendorId: dbVendorId,
        amount: Number(amount),
        category: category || 'Raw Materials',
        description: description || ''
      }
    });

    res.status(201).json(newExpense);
  } catch (error) {
    res.status(500).json({ error: 'Failed to log inventory expense' });
  }
});

// 2. Get Today's Profit & Loss
app.get('/api/vendors/:vendorId/profit/today', async (req, res) => {
  try {
    const dbVendorId = await getDbVendorId(req.params.vendorId);
    if (!dbVendorId) return res.status(404).json({ error: 'Vendor not found' });

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const todaysOrders = await prisma.order.aggregate({
      where: { 
        vendorId: dbVendorId, 
        createdAt: { gte: startOfToday }, 
        kitchenStatus: 'completed' 
      },
      _sum: { total: true }
    });

    const todaysExpenses = await prisma.dailyExpense.findMany({
      where: { 
        vendorId: dbVendorId, 
        date: { gte: startOfToday } 
      },
      orderBy: { date: 'desc' }
    });

    const grossRevenue = todaysOrders._sum.total || 0;
    const totalCost = todaysExpenses.reduce((sum, exp) => sum + exp.amount, 0);
    const netProfit = grossRevenue - totalCost;

    res.json({
      success: true,
      grossRevenue,
      totalCost,
      netProfit,
      expensesList: todaysExpenses
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to calculate daily profit' });
  }
});

// --- 📦 INVENTORY & RECIPES MANAGEMENT ---

// 1. Get Raw Inventory Items
app.get('/api/vendors/:vendorId/inventory', async (req, res) => {
  try {
    const dbVendorId = await getDbVendorId(req.params.vendorId);
    if (!dbVendorId) return res.status(404).json({ error: 'Vendor not found' });

    const items = await prisma.inventoryItem.findMany({
      where: { vendorId: dbVendorId },
      orderBy: { name: 'asc' }
    });
    res.json({ items });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch inventory' });
  }
});

// 2. Create Raw Inventory Item
app.post('/api/vendors/:vendorId/inventory', async (req, res) => {
  try {
    const dbVendorId = await getDbVendorId(req.params.vendorId);
    if (!dbVendorId) return res.status(404).json({ error: 'Vendor not found' });

    const { name, unit, currentStock, minAlert, costPerUnit, totalPurchaseCost } = req.body;

    const result = await prisma.$transaction(async (tx) => {
      const item = await tx.inventoryItem.create({
        data: {
          vendorId: dbVendorId,
          name: name.trim(),
          unit,
          currentStock: Number(currentStock) || 0,
          minAlert: Number(minAlert) || 0,
          costPerUnit: Number(costPerUnit) || 0
        }
      });

      if (Number(totalPurchaseCost) > 0) {
        await tx.dailyExpense.create({
          data: {
            vendorId: dbVendorId,
            description: `Initial Stock: ${name.trim()} (${currentStock} ${unit})`,
            amount: Number(totalPurchaseCost),
            category: 'INVENTORY_PURCHASE',
            date: new Date()
          }
        });
      }

      return item;
    });

    res.json({ success: true, item: result });
  } catch (error) {
    res.status(500).json({ error: 'Failed to register inventory item' });
  }
});

// 3. Link Ingredients to a Dish (Save Recipe)
app.post('/api/vendors/:vendorId/menu/:itemId/recipe', requireAuth, async (req, res) => {
  try {
    const { ingredients } = req.body;

    await prisma.recipeItem.deleteMany({
      where: { menuItemId: req.params.itemId as string }
    });

    if (Array.isArray(ingredients) && ingredients.length > 0) {
      await prisma.recipeItem.createMany({
        data: ingredients.map((ing: any) => ({
          menuItemId: req.params.itemId as string,
          inventoryItemId: ing.inventoryItemId,
          quantityUsed: Number(ing.quantityUsed)
        }))
      });
    }

    res.json({ success: true, message: 'Recipe configuration saved' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to link recipe ingredients' });
  }
});

// 🌟 3.1 GET Saved Recipe Ingredients (Required by MenuEditor.tsx)
app.get('/api/vendors/:vendorId/menu/:itemId/recipe', requireAuth, async (req, res) => {
  try {
    const recipe = await prisma.recipeItem.findMany({
      where: { menuItemId: req.params.itemId as string },
      include: { inventoryItem: true }
    });
    res.json({ recipe });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch recipe configuration' });
  }
});

// 4. Refill Stock & Auto-Restore Dependent Dishes
app.post('/api/vendors/:vendorId/inventory/:itemId/restock', requireAuth, async (req, res) => {
  try {
    const { quantityToAdd, totalPurchaseCost } = req.body;
    const dbVendorId = await getDbVendorId(req.params.vendorId);
    if (!dbVendorId) return res.status(404).json({ error: 'Vendor not found' });

    const itemId = req.params.itemId as string;
    const qty = Number(quantityToAdd);
    const cost = Number(totalPurchaseCost);

    if (qty <= 0) return res.status(400).json({ error: 'Invalid quantity' });

    const updatedItem = await prisma.$transaction(async (tx) => {
      const item = await tx.inventoryItem.findUnique({ where: { id: itemId } });
      if (!item) throw new Error('Ingredient not found');

      const newCostPerUnit = cost > 0 ? cost / qty : item.costPerUnit;

      const updated = await tx.inventoryItem.update({
        where: { id: itemId },
        data: {
          currentStock: { increment: qty },
          costPerUnit: newCostPerUnit
        }
      });

      if (cost > 0) {
        await tx.dailyExpense.create({
          data: {
            vendorId: dbVendorId,
            amount: cost,
            category: 'Raw Materials',
            description: `Refilled ${qty} ${item.unit} of ${item.name}`
          }
        });
      }

      // Check all recipes dependent on this ingredient and restore dishes if possible
      const linkedRecipes = await tx.recipeItem.findMany({
        where: { inventoryItemId: itemId },
        select: { menuItemId: true }
      });

      for (const link of linkedRecipes) {
        const fullRecipe = await tx.recipeItem.findMany({
          where: { menuItemId: link.menuItemId },
          include: { inventoryItem: true }
        });

        const canMakeOne = fullRecipe.every(
          (r) => r.inventoryItem.currentStock >= r.quantityUsed
        );

        if (canMakeOne) {
          await tx.menuItem.update({
            where: { id: link.menuItemId },
            data: { available: true }
          });
        }
      }

      return updated;
    });

    res.json(updatedItem);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to refill stock' });
  }
});

// --- 💳 PAYMENT DATA ROUTES ---

// 1. Save or Update Payment Profile (Clerk ID Sanitized)
app.post('/api/vendors/:vendorId/payment', async (req, res) => {
  try {
    const dbVendorId = await getDbVendorId(req.params.vendorId);
    if (!dbVendorId) return res.status(404).json({ error: 'Vendor not found' });

    const { paymentType, upiId, qrImagePath, razorpayKeyId, razorpayKeySecret, isActive } = req.body;
    const secureSecret = razorpayKeySecret ? encrypt(razorpayKeySecret) : undefined;
    const secureUpi = upiId ? encrypt(upiId) : '';

    await prisma.paymentData.upsert({
      where: { vendorId: dbVendorId },
      update: {
        paymentType,
        upiId: secureUpi,
        qrImagePath,
        razorpayKeyId,
        ...(secureSecret ? { razorpayKeySecret: secureSecret } : {}),
        isActive
      },
      create: {
        vendorId: dbVendorId,
        paymentType: paymentType || 'UPI',
        upiId: secureUpi,
        qrImagePath: qrImagePath || '',
        razorpayKeyId: razorpayKeyId || '',
        razorpayKeySecret: secureSecret || '',
        isActive: isActive ?? true
      }
    });
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save payment data' });
  }
});

// 2. Retrieve Decrypted Payment Profile for Settings
app.get('/api/vendors/:vendorId/payment', async (req, res) => {
  try {
    const dbVendorId = await getDbVendorId(req.params.vendorId);
    if (!dbVendorId) return res.status(404).json({ error: 'Vendor not found' });

    const paymentData = await prisma.paymentData.findUnique({
      where: { vendorId: dbVendorId }
    });
    
    if (!paymentData) return res.status(404).json({ error: 'Payment data not found' });

    res.json({
      paymentType: paymentData.paymentType,
      upiId: paymentData.upiId,
      qrImagePath: paymentData.qrImagePath,
      razorpayKeyId: paymentData.razorpayKeyId,
      hasRazorpaySecret: Boolean(paymentData.razorpayKeySecret),
      isActive: paymentData.isActive
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch payment data' });
  }
});

// 3. Create Razorpay Financial Order
app.post('/api/checkout/razorpay', async (req, res) => {
  try {
    const { vendorId, amount } = req.body;
    if (!vendorId || amount == null) {
      return res.status(400).json({ error: 'vendorId and amount are required' });
    }

    const dbVendorId = await getDbVendorId(vendorId);
    if (!dbVendorId) return res.status(404).json({ error: 'Vendor not found' });

    const paymentData = await prisma.paymentData.findUnique({
      where: { vendorId: dbVendorId }
    });

    if (!paymentData || !paymentData.razorpayKeyId || !paymentData.razorpayKeySecret) {
      return res.status(400).json({ error: 'Restaurant has not configured Razorpay correctly.' });
    }
    
    const unscrambledSecret = decrypt(paymentData.razorpayKeySecret);
    const razorpay = new Razorpay({
      key_id: paymentData.razorpayKeyId,
      key_secret: unscrambledSecret
    });

    const options = {
      amount: Math.round(amount * 100),
      currency: 'INR',
      receipt: `receipt_${Date.now()}`
    };

    const order = await razorpay.orders.create(options);
    res.json(order);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create Razorpay order' });
  }
});

// 4. Retrieve Public Payment Config for Customer Checkout
app.get('/api/vendors/:vendorId/payment/public', async (req, res) => {
  try {
    const dbVendorId = await getDbVendorId(req.params.vendorId);
    if (!dbVendorId) return res.status(404).json({ error: 'Vendor not found' });

    const vendor = await prisma.vendor.findUnique({
      where: { id: dbVendorId },
      include: { paymentData: true }
    });

    const rawPaymentData = vendor?.paymentData;
    const activePaymentConfig = Array.isArray(rawPaymentData) ? rawPaymentData[0] : rawPaymentData;

    if (!activePaymentConfig || !activePaymentConfig.isActive) {
      return res.json({ available: false });
    }

    const decryptedUpi = activePaymentConfig.upiId ? decrypt(activePaymentConfig.upiId) : '';
    res.json({ 
      available: true,
      paymentType: activePaymentConfig.paymentType, 
      upiId: decryptedUpi, 
      qrImagePath: activePaymentConfig.qrImagePath,
      razorpayKeyId: activePaymentConfig.razorpayKeyId
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve public payment data' });
  }
});

// --- 📋 MENU ROUTES ---

// 1. Fetch Customer Menu (Includes depleted dishes so they render with Sold-Out badges)
app.get('/api/vendors/:vendorId/menu', async (req, res) => {
  try {
    const dbVendorId = await getDbVendorId(req.params.vendorId);
    if (!dbVendorId) return res.status(404).json({ error: 'Vendor not found' });

    const items = await prisma.menuItem.findMany({
      where: { vendorId: dbVendorId },
      orderBy: [{ available: 'desc' }, { name: 'asc' }]
    });
    res.json({ items });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch menu' });
  }
});

// 2. Fetch Menu for Menu Editor
app.get('/api/vendors/:vendorId/menu-editor', async (req, res) => {
  try {
    const dbVendorId = await getDbVendorId(req.params.vendorId);
    if (!dbVendorId) return res.status(404).json({ error: 'Vendor not found' });

    const items = await prisma.menuItem.findMany({ 
      where: { vendorId: dbVendorId },
      orderBy: { category: 'asc' }
    });
    
    res.json({ items });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch editor menu' });
  }
});

// 3. Create Menu Item
app.post('/api/vendors/:vendorId/menu', async (req, res) => {
  try {
    const dbVendorId = await getDbVendorId(req.params.vendorId);
    if (!dbVendorId) return res.status(404).json({ error: 'Vendor not found' });

    const newItem = await prisma.menuItem.create({
      data: {
        name: req.body.name,
        category: req.body.category,
        price: Number(req.body.price),
        prep: req.body.prep,
        veg: req.body.veg,
        available: req.body.available,
        imageUrl: req.body.imageUrl || null,
        description: req.body.description || null,
        costPrice: req.body.costPrice ? Number(req.body.costPrice) : null,
        emoji: req.body.emoji || null,
        remarks: req.body.remarks || null,
        badgeLabel: req.body.badgeLabel || null,
        vendorId: dbVendorId
      }
    });

    res.status(201).json(newItem);
  } catch (error) {
    res.status(500).json({ error: 'Failed to save menu item' });
  }
});

// 4. Update Menu Item
app.patch('/api/vendors/:vendorId/menu/:itemId', requireAuth, async (req, res) => {
  try {
    const updatedItem = await prisma.menuItem.update({
      where: { id: req.params.itemId as string },
      data: req.body
    });
    res.json(updatedItem);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update item' });
  }
});

// 5. Delete Menu Item
app.delete('/api/vendors/:vendorId/menu/:itemId', requireAuth, async (req, res) => {
  try {
    await prisma.menuItem.delete({ where: { id: req.params.itemId as string } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete item' });
  }
});

// --- 🎟️ OFFERS & PROMOS ROUTES ---

// 1. Get Promos
app.get('/api/vendors/:vendorId/promos', async (req, res) => {
  try {
    const dbVendorId = await getDbVendorId(req.params.vendorId);
    if (!dbVendorId) return res.status(404).json({ error: 'Vendor not found' });

    const now = new Date();
    const promos = await prisma.promo.findMany({
      where: { 
        vendorId: dbVendorId,
        isActive: true,
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: now } }
        ]
      },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ promos });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch promos' });
  }
});

// 2. Create or Update Promo
app.post('/api/vendors/:vendorId/promos', requireAuth, async (req, res) => {
  try {
    const dbVendorId = await getDbVendorId(req.params.vendorId as string);
    if (!dbVendorId) return res.status(404).json({ error: 'Vendor not found' });

    const { code, type, value, minOrderValue, maxUses, expiresAt, applyTo } = req.body;
    const cleanCode = code.trim().toUpperCase();

    const savedPromo = await prisma.promo.upsert({
      where: {
        vendorId_code: {
          vendorId: dbVendorId,
          code: cleanCode
        }
      },
      update: {
        type,
        value: Number(value),
        minOrderValue: Number(minOrderValue || 0),
        maxUses: maxUses ? Number(maxUses) : null,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        isActive: true,
        applyTo: applyTo || 'ALL'
      },
      create: {
        vendorId: dbVendorId,
        code: cleanCode,
        type,
        value: Number(value),
        minOrderValue: Number(minOrderValue || 0),
        maxUses: maxUses ? Number(maxUses) : null,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        isActive: true,
        applyTo: applyTo || 'ALL'
      }
    });
    
    res.json(savedPromo);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to save promo' });
  }
});

// 3. Delete Promo
app.delete('/api/vendors/:vendorId/promos/:promoId', async (req, res) => {
  try {
    await prisma.promo.delete({ where: { id: req.params.promoId } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete promo' });
  }
});

// 4. Verify Promo at Checkout
app.post('/api/vendors/:vendorId/promos/verify', async (req, res) => {
  try {
    const dbVendorId = await getDbVendorId(req.params.vendorId);
    if (!dbVendorId) return res.status(404).json({ error: 'Vendor not found' });

    const { code, cartItems } = req.body; 
    const cartTotal = cartItems.reduce((sum: number, item: any) => sum + (item.price * item.qty), 0);
    
    const promo = await prisma.promo.findFirst({
      where: { vendorId: dbVendorId, code: code.toUpperCase() }
    });

    if (!promo || !promo.isActive) return res.status(400).json({ error: 'Invalid or inactive promo code.' });
    if (cartTotal < promo.minOrderValue) return res.status(400).json({ error: `Cart must be at least ₹${promo.minOrderValue}.` });
    if (promo.expiresAt && new Date() > promo.expiresAt) return res.status(400).json({ error: 'This promo code has expired.' });
    if (promo.maxUses !== null && promo.currentUses >= promo.maxUses) return res.status(400).json({ error: 'Usage limit reached.' });

    let eligibleTotal = cartTotal;

    if (promo.applyTo !== 'ALL') {
      eligibleTotal = cartItems
        .filter((item: any) => item.category === promo.applyTo || item.name === promo.applyTo)
        .reduce((sum: number, item: any) => sum + (item.price * item.qty), 0);

      if (eligibleTotal === 0) {
        return res.status(400).json({ error: `This code only applies to ${promo.applyTo}.` });
      }
    }

    let discountAmount = 0;
    if (promo.type === 'FLAT') {
      discountAmount = Math.min(promo.value, eligibleTotal);
    } else if (promo.type === 'PERCENTAGE' || promo.type === 'Percentage discount (%)') {
      discountAmount = (eligibleTotal * promo.value) / 100;
    }

    res.json({ 
      success: true, 
      promoId: promo.id,
      discountAmount: Math.round(discountAmount), 
      newTotal: Math.round(cartTotal - discountAmount) 
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to verify promo.' });
  }
});

// --- 📊 ANALYTICS ROUTE ---
app.get('/api/vendors/:vendorId/analytics', requireAuth, async (req, res) => {
  try {
    const dbVendorId = await getDbVendorId(req.params.vendorId as string);
    if (!dbVendorId) return res.status(404).json({ error: 'Vendor not found' });

    const today = new Date();
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(today.getDate() - 30);

    const orders = await prisma.order.findMany({
      where: {
        vendorId: dbVendorId,
        createdAt: { gte: thirtyDaysAgo },
        kitchenStatus: 'completed'
      },
      include: { items: true }
    });

    const totalOrders = orders.length;
    let totalRevenue = 0;
    let upi = 0, cash = 0, card = 0;

    orders.forEach((o: any) => {
      totalRevenue += o.total;
      if (o.paymentMode === 'UPI') upi++;
      else if (o.paymentMode === 'CASH') cash++;
      else card++;
    });

    const avgOrder = totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0;
    const calcPercent = (val: number) => totalOrders > 0 ? Math.round((val / totalOrders) * 100) : 0;

    const itemTracker: Record<string, any> = {};
    orders.forEach((order: any) => {
      const items = Array.isArray(order.items) ? order.items : [];
      items.forEach((item: any) => {
        if (!itemTracker[item.name]) {
          itemTracker[item.name] = { id: item.id, name: item.name, rev: 0, sold: 0 };
        }
        itemTracker[item.name].rev += (item.price * item.qty);
        itemTracker[item.name].sold += item.qty;
      });
    });

    const topItems = Object.values(itemTracker)
      .sort((a: any, b: any) => b.rev - a.rev)
      .slice(0, 5)
      .map((item: any) => ({
        ...item,
        rev: item.rev.toLocaleString('en-IN')
      }));

    const dailyRevenue = new Array(30).fill(0);
    orders.forEach((order: any) => {
      const diffTime = Math.abs(today.getTime() - new Date(order.createdAt).getTime());
      const daysAgo = Math.floor(diffTime / (1000 * 60 * 60 * 24));
      if (daysAgo < 30) {
        dailyRevenue[29 - daysAgo] += order.total;
      }
    });

    const maxDaily = Math.max(...dailyRevenue, 1);
    const trend = dailyRevenue.map(rev => Math.round((rev / maxDaily) * 100));

    const hourBuckets = { morning: 0, lunch: 0, evening: 0, night: 0 };
    orders.forEach((order: any) => {
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
      { label: '9–11 AM', percentage: peakPercent(hourBuckets.morning) }
    ];

    res.json({
      revenue: totalRevenue.toLocaleString('en-IN'),
      orders: totalOrders,
      avgOrder,
      rating: 4.8, 
      paymentSplit: [
        { label: 'UPI / QR', percentage: calcPercent(upi), color: 'bg-blue-500' },
        { label: 'Cash', percentage: calcPercent(cash), color: 'bg-[#E5B35C]' },
        { label: 'Card', percentage: calcPercent(card), color: 'bg-gray-500' }
      ],
      peakHours,
      topItems,
      trend
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// --- 🛍️ ORDER & CHECKOUT ENGINE ---

// Create Order (Atomic Stock Decrement & Auto-86)
app.post('/api/orders', async (req, res) => {
  try {
    const { vendorId, tableId, customerName, items, total, paymentMode, customerPhone } = req.body;
    const dbVendorId = await getDbVendorId(vendorId);
    if (!dbVendorId) return res.status(404).json({ error: 'Vendor not found to attach order to.' });

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const newOrder = await prisma.$transaction(async (tx) => {
      const lastOrder = await tx.order.findFirst({
        where: {
          vendorId: dbVendorId,
          createdAt: { gte: startOfToday },
        },
        orderBy: { token: 'desc' },
      });
      const nextToken = lastOrder?.token ? lastOrder.token + 1 : 1;

      const cartItemNames = items.map((i: any) => i.name.trim());
      const menuItems = await tx.menuItem.findMany({
        where: {
          vendorId: dbVendorId,
          name: { in: cartItemNames, mode: 'insensitive' }
        },
        include: {
          recipes: {
            include: { inventoryItem: true }
          }
        }
      });

      const ingredientDemand = new Map<string, { item: any; totalNeeded: number; dishNames: string[] }>();

      for (const cartItem of items) {
        const matchedDish = menuItems.find(
          (m: any) => m.name.toLowerCase() === cartItem.name.trim().toLowerCase()
        );

        if (matchedDish && matchedDish.recipes?.length > 0) {
          for (const recipe of matchedDish.recipes) {
            const qtyUsed = Number(recipe.quantityUsed) * Number(cartItem.qty);
            const existing = ingredientDemand.get(recipe.inventoryItemId);

            if (existing) {
              existing.totalNeeded += qtyUsed;
              existing.dishNames.push(cartItem.name);
            } else {
              ingredientDemand.set(recipe.inventoryItemId, {
                item: recipe.inventoryItem,
                totalNeeded: qtyUsed,
                dishNames: [cartItem.name]
              });
            }
          }
        }
      }

      for (const [, demand] of ingredientDemand.entries()) {
        if (demand.item.currentStock < demand.totalNeeded) {
          const shortageError: any = new Error(
            `Insufficient stock for "${demand.item.name}". Required: ${demand.totalNeeded} ${demand.item.unit}, Available: ${demand.item.currentStock} ${demand.item.unit}. Affects: ${demand.dishNames.join(', ')}.`
          );
          shortageError.statusCode = 400;
          throw shortageError;
        }
      }

      const createdOrder = await tx.order.create({
        data: {
          vendorId: dbVendorId,
          token: nextToken,
          customerName: customerName || 'Counter Order',
          customerPhone: customerPhone || '0000000000',
          paymentMode,
          tableId: tableId || 'Counter',
          total,
          kitchenStatus: 'pending',
          items: {
            create: items.map((cartItem: any) => ({
              name: cartItem.name,
              qty: cartItem.qty,
              price: cartItem.price 
            }))
          }
        }
      });

      for (const [inventoryId, demand] of ingredientDemand.entries()) {
        const updatedStock = await tx.inventoryItem.update({
          where: { id: inventoryId },
          data: {
            currentStock: { decrement: demand.totalNeeded }
          }
        });

        const dependentRecipes = await tx.recipeItem.findMany({
          where: { inventoryItemId: updatedStock.id },
          select: { menuItemId: true, quantityUsed: true }
        });

        const dishIdsToDisable = dependentRecipes
          .filter((r) => updatedStock.currentStock < r.quantityUsed)
          .map((r) => r.menuItemId);

        if (dishIdsToDisable.length > 0) {
          await tx.menuItem.updateMany({
            where: { id: { in: dishIdsToDisable } },
            data: { available: false }
          });
        }
      }

      return createdOrder;
    });

    res.status(201).json({ id: newOrder.id, tokenNumber: newOrder.token.toString() });
  } catch (error: any) {
    if (error.statusCode === 400) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// Kitchen Queue (Excludes completed and cancelled orders)
app.get('/api/vendors/:vendorId/kitchen-queue', async (req, res) => {
  try {
    const dbVendorId = await getDbVendorId(req.params.vendorId);
    if (!dbVendorId) return res.status(404).json({ error: 'Vendor not found' });

    const orders = await prisma.order.findMany({
      where: {
        vendorId: dbVendorId,
        kitchenStatus: { notIn: ['completed', 'cancelled', 'rejected'] }
      },
      include: { items: true },
      orderBy: { createdAt: 'asc' }
    });
    res.json({ orders });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch queue' });
  }
});

// Update Kitchen Status (Restores inventory if cancelled)
app.patch('/api/orders/:orderId/kitchen-status', requireAuth, async (req, res) => {
  const { orderId } = req.params;
  const { status } = req.body;

  try {
    const updatedOrder = await prisma.$transaction(async (tx) => {
      const existingOrder = await tx.order.findUnique({
        where: { id: orderId as string },
        include: { items: true }
      });

      if (!existingOrder) throw new Error('Order not found');

      const isCancelling =
        (status === 'cancelled' || status === 'rejected') &&
        existingOrder.kitchenStatus !== 'cancelled' &&
        existingOrder.kitchenStatus !== 'rejected';

      if (isCancelling) {
        for (const orderItem of existingOrder.items) {
          const menuItem = await tx.menuItem.findFirst({
            where: {
              vendorId: existingOrder.vendorId,
              name: { equals: orderItem.name.trim(), mode: 'insensitive' }
            },
            include: { recipes: true }
          });

          if (menuItem && menuItem.recipes.length > 0) {
            for (const recipe of menuItem.recipes) {
              const restoreQty = Number(recipe.quantityUsed) * Number(orderItem.qty);
              const restoredStock = await tx.inventoryItem.update({
                where: { id: recipe.inventoryItemId },
                data: { currentStock: { increment: restoreQty } }
              });

              if (restoredStock.currentStock >= recipe.quantityUsed) {
                await tx.menuItem.update({
                  where: { id: menuItem.id },
                  data: { available: true }
                });
              }
            }
          }
        }
      }

      return await tx.order.update({
        where: { id: orderId as string },
        data: {
          kitchenStatus: status,
          status
        }
      });
    });

    res.json(updatedOrder);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// Check Single Order Status (For Customer Tracker)
app.get('/api/orders/:orderId/status', async (req, res) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: req.params.orderId as string },
      select: { id: true, token: true, kitchenStatus: true, status: true }
    });

    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(order);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch status' });
  }
});

// Mock OTP Send
app.post('/api/otp/send', async (req, res) => {
  const { phone } = req.body;
  if (!phone) {
    return res.status(400).json({ error: 'Phone number is required' });
  }

  let formattedPhone = phone.replace(/\D/g, ''); 
  if (formattedPhone.length === 10) formattedPhone = `91${formattedPhone}`;

  return res.json({ sent: true, phone: formattedPhone });
});

// Mock OTP Verify
app.post('/api/otp/verify', async (req, res) => {
  const { phone, otp } = req.body;
  if (!phone || !otp) {
    return res.status(400).json({ error: 'Phone number and OTP are both required' });
  }

  const formattedPhone = phone.replace(/\D/g, '');
  if (otp === '1234' || otp === '123456') {
    return res.json({ verified: true, phone: formattedPhone });
  } else {
    return res.status(400).json({ error: 'Invalid mock OTP code. Please use 1234.' });
  }
});

// Completed Sales Records for History & Reports
app.get('/api/vendors/:vendorId/sales', requireAuth, async (req, res) => {
  try {
    const dbVendorId = await getDbVendorId(req.params.vendorId as string);
    if (!dbVendorId) return res.status(404).json({ error: 'Vendor not found' });

    const orders = await prisma.order.findMany({
      where: { vendorId: dbVendorId, kitchenStatus: 'completed' },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ orders }); 
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch sales data' });
  }
});

// --- 🎨 BRANDING STUDIO ROUTES ---

app.get('/api/vendors/:vendorId/branding', requireAuth, async (req, res) => {
  try {
    const dbVendorId = await getDbVendorId(req.params.vendorId as string);
    if (!dbVendorId) return res.status(404).json({ error: 'Vendor profile not found' });

    const vendor = await prisma.vendor.findUnique({
      where: { id: dbVendorId }
    });

    if (!vendor) return res.status(404).json({ error: 'Vendor profile not found' });

    return res.status(200).json({
      storeName: vendor.name || 'Your Store',
      branding: {
        themeMode: (vendor as any).themeMode || 'dark', 
        accentColor: (vendor as any).accentColor || '#E5B35C', 
        fontFamily: (vendor as any).fontFamily || 'font-sans',
        buttonRoundness: (vendor as any).buttonRoundness || 'rounded-xl',
        logoUrl: vendor.logoUrl, 
        bannerUrl: vendor.bannerUrl 
      }
    });
  } catch (error) {
    return res.status(500).json({ error: 'Internal server failure' });
  }
});

app.patch('/api/vendors/:vendorId/branding', requireAuth, async (req, res) => {
  try {
    const dbVendorId = await getDbVendorId(req.params.vendorId as string);
    if (!dbVendorId) return res.status(404).json({ error: 'Vendor not found' });

    const { themeMode, accentColor, fontFamily, buttonRoundness, logoUrl, bannerUrl, showOfferStrip, offerText } = req.body;

    const updatedVendor = await prisma.vendor.update({
      where: { id: dbVendorId }, 
      data: { 
        themeMode, 
        accentColor, 
        fontFamily,
        buttonRoundness,
        showOfferStrip,
        offerText,
        ...(logoUrl && { logoUrl }), 
        ...(bannerUrl && { bannerUrl }) 
      } as any 
    });
    
    return res.status(200).json({
      success: true,
      branding: {
        themeMode: (updatedVendor as any).themeMode, 
        accentColor: (updatedVendor as any).accentColor, 
        fontFamily: (updatedVendor as any).fontFamily,
        buttonRoundness: (updatedVendor as any).buttonRoundness,
        showOfferStrip: (updatedVendor as any).showOfferStrip,
        offerText: (updatedVendor as any).offerText,
        logoUrl: updatedVendor.logoUrl, 
        bannerUrl: updatedVendor.bannerUrl 
      }
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to update branding settings' });
  }
});

// --- 🚨 GLOBAL ERROR CATCHER ---
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('🔥 Server Error:', err.message || err);
  
  if (err.message === 'Unauthenticated' || err.message.includes('token')) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or expired session token' });
  }

  res.status(500).json({ error: 'Internal Server Error', details: err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Pabee Backend running on port ${PORT}`));