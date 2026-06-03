import express from 'express';
import jwt from 'jsonwebtoken';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';
import Razorpay from 'razorpay';
import { Webhook } from 'svix';

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_1234567890abcd',
  key_secret: process.env.RAZORPAY_KEY_SECRET || '1234567890abcdef1234567890abcdef',
});
const prisma = new PrismaClient();
const app = express();

app.use(cors({
  origin: [
    'http://localhost:5173', // Your local Vite server
    'http://localhost:3000', 
    'https://project-r73rm.vercel.app' // 👈 IMPORTANT: live Vercel link here!
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
}));

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
    let evt;

    try {
      evt = wh.verify(payload, {
        'svix-id': svix_id,
        'svix-timestamp': svix_timestamp,
        'svix-signature': svix_signature,
      }) as any;
    } catch (err: any) {
      console.error('Webhook verification failed:', err.message);
      return res.status(400).json({ error: 'Verification failed' });
    }

    // If it's a new user signup, create their database profile!
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
        console.log(`✅ Database profile created for new vendor: ${primaryEmail}`);
      } catch (error) {
        console.error('🔥 Failed to save new vendor to DB:', error);
      }
    }

    return res.status(200).json({ success: true });
  }
);

app.use(express.json());

// --- 🌟 UPDATED AUTO-SEED FUNCTION 🌟 ---
async function seedDatabase() {
  try {
    const itemCount = await prisma.menuItem.count();
    
    if (itemCount === 0) {
      console.log("🌱 No menu items found. Injecting default menu...");
      
      // 1. Ensure the vendor exists (won't crash if you already made it in Prisma Studio)
      await prisma.vendor.upsert({
        where: { id: 'spice-street-kitchen' },
        update: {},
        create: {
          id: 'spice-street-kitchen',
          clerkId: 'dummy_clerk_id_123',     // 👈 ADD THIS LINE
          email: 'test@spicestreet.com',
          name: 'Spice Street Kitchen',
          businessType: 'Street Food',
          tier: 1,
        }
      });

      // 2. Inject the missing menu items
      await prisma.menuItem.createMany({
        data: [
          { vendorId: 'spice-street-kitchen', name: 'Pav Bhaji', category: 'Food', price: 80, prep: '10 min', veg: true },
          { vendorId: 'spice-street-kitchen', name: 'Vada Pav', category: 'Snacks', price: 25, prep: '5 min', veg: true },
          { vendorId: 'spice-street-kitchen', name: 'Chicken Wrap', category: 'Non-veg', price: 120, prep: '12 min', veg: false },
          { vendorId: 'spice-street-kitchen', name: 'Cutting Chai', category: 'Drinks', price: 15, prep: '3 min', veg: true }
        ]
      });
      console.log("✅ Menu items successfully injected!");
    } else {
      console.log(`✅ Database already has ${itemCount} menu items ready to go.`);
    }
  } catch (err) {
    console.log("Database not ready yet or connection error:", err);
  }
}
seedDatabase();
// --------------------------------

// --- ⚙️ SETTINGS & PROFILE ROUTES ---

// 1. Get Vendor Profile
app.get('/api/vendors/:vendorId/profile', async (req, res) => {
  try {
    // We search by clerkId since that is what the frontend Auth context provides
    const vendor = await prisma.vendor.findUnique({
      where: { clerkId: req.params.vendorId }
    });
    
    if (!vendor) return res.status(404).json({ error: 'Vendor profile not found' });
    
    res.json(vendor);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch vendor profile' });
  }
});

// 2. Update Vendor Profile (Store Name & Type)
app.patch('/api/vendors/:vendorId/profile', async (req, res) => {
  try {
    const { name, businessType } = req.body;
    
    const updatedVendor = await prisma.vendor.update({
      where: { clerkId: req.params.vendorId },
      data: { name, businessType }
    });
    
    res.json(updatedVendor);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update vendor profile' });
  }
});

// 1. Fetch Menu (Customer View)
app.get('/api/vendors/:vendorId/menu', async (req, res) => {
  const { vendorId } = req.params;
  try {
    // Notice how it only sends items where available: true
    const items = await prisma.menuItem.findMany({ where: { vendorId, available: true } });
    res.json({ items });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch menu' });
  }
});

// --- MENU EDITOR ROUTES ---

// 1.1 Get ALL Menu Items (Including hidden ones for the Editor)
app.get('/api/vendors/:vendorId/menu-editor', async (req, res) => {
  try {
    const items = await prisma.menuItem.findMany({ 
      where: { vendorId: req.params.vendorId },
      orderBy: { category: 'asc' }
    });
    res.json({ items });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch menu for editor' });
  }
});

// 1.2 Add New Item
app.post('/api/vendors/:vendorId/menu', async (req, res) => {
  try {
    const { name, category, price, prep, veg, available } = req.body;
    const newItem = await prisma.menuItem.create({
      data: {
        vendorId: req.params.vendorId,
        name, category, price: Number(price), prep: prep || '10 min', veg, available
      }
    });
    res.json(newItem);
  } catch (error) {
    res.status(500).json({ error: 'Failed to add item' });
  }
});

// 1.3 Update Item (Edit details or toggle In-Stock/Out-of-Stock)
app.patch('/api/vendors/:vendorId/menu/:itemId', async (req, res) => {
  try {
    const updatedItem = await prisma.menuItem.update({
      where: { id: req.params.itemId },
      data: req.body // Prisma is smart enough to only update the fields provided
    });
    res.json(updatedItem);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update item' });
  }
});

// 1.4 Delete Item
app.delete('/api/vendors/:vendorId/menu/:itemId', async (req, res) => {
  try {
    await prisma.menuItem.delete({ where: { id: req.params.itemId } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete item' });
  }
});


// --- 🎟️ OFFERS & PROMOS ROUTES ---

// 1. Get all promos (For Vendor Dashboard)
app.get('/api/vendors/:vendorId/promos', async (req, res) => {
  try {
    const promos = await prisma.promo.findMany({
      where: { vendorId: req.params.vendorId },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ promos });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch promos' });
  }
});

// 2. Create a new promo
app.post('/api/vendors/:vendorId/promos', async (req, res) => {
  try {
    const { code, type, value, minOrderValue, maxUses, expiresAt, isActive } = req.body;
    
    const newPromo = await prisma.promo.create({
      data: {
        vendorId: req.params.vendorId,
        code: code.toUpperCase(), // Always force uppercase!
        type,
        value: Number(value),
        minOrderValue: Number(minOrderValue || 0),
        maxUses: maxUses ? Number(maxUses) : null,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        isActive
      }
    });
    res.json(newPromo);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create promo. Code might already exist.' });
  }
});

// 3. Delete a promo
app.delete('/api/vendors/:vendorId/promos/:promoId', async (req, res) => {
  try {
    await prisma.promo.delete({ where: { id: req.params.promoId } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete promo' });
  }
});

// 4. 🛑 VERIFY A PROMO (For Customer Checkout) - THE IMPORTANT MATH!
app.post('/api/vendors/:vendorId/promos/verify', async (req, res) => {
  try {
    const { code, cartTotal } = req.body;
    
    // Find the promo
    const promo = await prisma.promo.findUnique({
      where: {
        vendorId_code: { vendorId: req.params.vendorId, code: code.toUpperCase() }
      }
    });

    // Rule 1: Does it exist and is it turned on?
    if (!promo || !promo.isActive) {
      return res.status(400).json({ error: 'Invalid or inactive promo code.' });
    }

    // Rule 2: Did they spend enough?
    if (cartTotal < promo.minOrderValue) {
      return res.status(400).json({ error: `Cart must be at least ₹${promo.minOrderValue} to use this code.` });
    }

    // Rule 3: Is it expired?
    if (promo.expiresAt && new Date() > promo.expiresAt) {
      return res.status(400).json({ error: 'This promo code has expired.' });
    }

    // Rule 4: Has it been used too many times?
    if (promo.maxUses !== null && promo.currentUses >= promo.maxUses) {
      return res.status(400).json({ error: 'This promo code has reached its usage limit.' });
    }

    // If it passes all rules, calculate the discount!
    let discountAmount = 0;
    if (promo.type === 'FLAT') {
      discountAmount = promo.value;
    } else if (promo.type === 'PERCENTAGE') {
      discountAmount = (cartTotal * promo.value) / 100;
    }

    // Don't let the discount be more than the cart total itself!
    if (discountAmount > cartTotal) discountAmount = cartTotal;

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

// --- 📊 ADVANCED ANALYTICS ROUTE (TypeScript Safe!) ---
app.get('/api/vendors/:vendorId/analytics', async (req, res) => {
  try {
    const today = new Date();
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(today.getDate() - 30);

    // FIX 1: Add include: { items: true } so Prisma actually fetches the food items!
    const orders = await prisma.order.findMany({
      where: {
        vendorId: req.params.vendorId,
        createdAt: { gte: thirtyDaysAgo }
      },
      include: {
        items: true 
      }
    });

    const totalOrders = orders.length;
    let totalRevenue = 0;
    let upi = 0, cash = 0, card = 0;

    // Added (o: any) to satisfy TypeScript
    orders.forEach((o: any) => {
      totalRevenue += o.total;
      if (o.paymentMode === 'UPI') upi++;
      else if (o.paymentMode === 'CASH') cash++;
      else card++;
    });

    const avgOrder = totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0;
    const calcPercent = (val: number) => totalOrders > 0 ? Math.round((val / totalOrders) * 100) : 0;

    // ==========================================
    // ==========================================
    // 🧠 3. THE ADVANCED MATH: Top Items
    // ==========================================
    const itemTracker: Record<string, any> = {};
    
    orders.forEach((order: any) => {
      const items = Array.isArray(order.items) ? order.items : [];
      items.forEach((item: any) => {
        // 👇 Group by NAME instead of ID to merge duplicates!
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

    // ==========================================
    // 📈 4. THE ADVANCED MATH: 30-Day Trend
    // ==========================================
    let dailyRevenue = new Array(30).fill(0);
    
    orders.forEach((order: any) => {
      // FIX 4: Use .getTime() so TypeScript can subtract the dates properly
      const diffTime = Math.abs(today.getTime() - new Date(order.createdAt).getTime());
      const daysAgo = Math.floor(diffTime / (1000 * 60 * 60 * 24));
      
      if (daysAgo < 30) {
        const arrayIndex = 29 - daysAgo; 
        dailyRevenue[arrayIndex] += order.total;
      }
    });

    const maxDaily = Math.max(...dailyRevenue, 1);
    const trend = dailyRevenue.map(rev => Math.round((rev / maxDaily) * 100));

    // ==========================================
    // ⏰ 5. THE ADVANCED MATH: Peak Hours
    // ==========================================
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
      avgOrder: avgOrder,
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
    console.error("Analytics Error:", error);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// 2. Create Order (Checkout)
app.post('/api/orders', async (req, res) => {
  try {
    const { vendorId, tableId, items, total, paymentMode, customerPhone } = req.body;

    const newOrder = await prisma.order.create({
      data: {
        vendorId,
        tableId: tableId || 'Table-4',
        total,
        paymentMode,
        kitchenStatus: 'pending',
        
        items: {
          create: items.map((cartItem: any) => ({
            name: cartItem.name,
            qty: cartItem.qty,
            price: cartItem.price // 👈 THE MISSING PIECE
          }))
        }
      }
    });

    res.status(201).json(newOrder);

  } catch (error) {
    console.error("🔥 CRITICAL PRISMA ERROR IN /api/orders:", error); 
    res.status(500).json({ error: "Failed to create order" });
  }
});

// 3. Kitchen Queue (Polling Endpoint for KDS)
app.get('/api/vendors/:vendorId/kitchen-queue', async (req, res) => {
  const { vendorId } = req.params;
  try {
    const orders = await prisma.order.findMany({
      where: { vendorId, kitchenStatus: { not: 'completed' } },
      include: { items: true },
      orderBy: { createdAt: 'asc' }
    });
    res.json({ orders });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch queue' });
  }
});

// 4. Update Kitchen Status
app.patch('/api/orders/:orderId/kitchen-status', async (req, res) => {
  const { orderId } = req.params;
  const { status } = req.body;
  try {
    const order = await prisma.order.update({
      where: { id: orderId },
      data: { kitchenStatus: status }
    });
    res.json(order);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update status' });
  }
});


// 4.5 Check Single Order Status (For the Customer Pickup Screen)
app.get('/api/orders/:orderId/status', async (req, res) => {
  const { orderId } = req.params;
  try {
    const order = await prisma.order.findUnique({ 
      where: { id: orderId },
      select: { id: true, kitchenStatus: true } // We only need the status
    });
    
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(order);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch status' });
  }
});

// 5. Send OTP (MOCKED FOR DEVELOPMENT)
app.post('/api/otp/send', async (req, res) => {
  const { phone } = req.body;
  if (!phone) {
    return res.status(400).json({ error: 'Phone number is required' });
  }

  let formattedPhone = phone.replace(/\D/g, ''); 

  if (formattedPhone.length === 10) {
    formattedPhone = `91${formattedPhone}`;
  }

  // 🌟 THE MISSING LINE: Instantly tell the frontend it was a "success"
  console.log(`[MOCK] Pretending to send OTP to ${formattedPhone}`);
  return res.json({ sent: true, phone: formattedPhone });

 /* const authKey = process.env.MSG91_AUTH_KEY;
  const templateId = process.env.MSG91_TEMPLATE_ID;

  if (!authKey || !templateId) {
    console.error("Missing MSG91 Configuration Environment Variables.");
    return res.status(500).json({ error: 'SMS Gateway configuration error' });
  }

  try {
    const response = await fetch(`https://control.msg91.com/api/v5/otp?template_id=${templateId}&mobile=${formattedPhone}`, {
      method: 'POST',
      headers: {
        'authkey': authKey,
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json();

    if (response.ok && data.type === 'success') {
      return res.json({ sent: true, phone: formattedPhone });
    } else {
      console.error("MSG91 Error Response:", data);
      return res.status(response.status).json({ error: data.message || 'Failed to send OTP via gateway' });
    }
  } catch (error) {
    console.error("Network Error communicating with MSG91:", error);
    return res.status(500).json({ error: 'Internal server error communicating with SMS gateway' });
  }*/
});

// 6. Verify OTP (MOCKED FOR DEVELOPMENT)
app.post('/api/otp/verify', async (req, res) => {
  const { phone, otp } = req.body;

  if (!phone || !otp) {
    return res.status(400).json({ error: 'Phone number and OTP are both required' });
  }

  const formattedPhone = phone.replace(/\D/g, '');

  // 🌟 MOCK VERIFY: Use "1234" as the universal test password
  if (otp === '1234' || otp === '123456') {
    console.log(`[MOCK] Successfully verified OTP for ${formattedPhone}`);
    return res.json({ verified: true, phone: formattedPhone });
  } else {
    return res.status(400).json({ error: 'Invalid mock OTP code. Please use 1234.' });
  }
 /* const authKey = process.env.MSG91_AUTH_KEY;

  if (!authKey) {
    return res.status(500).json({ error: 'SMS Gateway configuration error' });
  }

  try {
    const response = await fetch(`https://control.msg91.com/api/v5/otp/verify?otp=${otp}&mobile=${formattedPhone}`, {
      method: 'GET',
      headers: {
        'authkey': authKey
      }
    });

    const data = await response.json();

    if (response.ok && data.type === 'success') {
      return res.json({ verified: true, phone: formattedPhone });
    } else {
      console.error("MSG91 Verification Failure:", data);
      return res.status(400).json({ error: data.message || 'Invalid or expired OTP code' });
    }
  } catch (error) {
    console.error("Network Error during MSG91 verification:", error);
    return res.status(500).json({ error: 'Internal server error verifying token code' });
  } */
});

// 7. Get Vendor Sales Dashboard Data
app.get('/api/vendors/:vendorId/sales', async (req, res) => {
  const { vendorId } = req.params;
  try {
    // Fetch all completed orders
    const orders = await prisma.order.findMany({
      where: { vendorId, kitchenStatus: 'completed' },
      include: { items: true }, // 👈 CRUCIAL: Include the items for the "Top Selling" calculation!
      orderBy: { createdAt: 'desc' }, // Newest first
    });

    // 3. Send it back EXACTLY how the frontend Overview tab expects it
    res.json({ orders: orders }); 
    
  } catch (error) {
    console.error("Sales Endpoint Error:", error);
    res.status(500).json({ error: 'Failed to fetch sales data' });
  }
});



app.post('/api/razorpay/create-order', async (req, res) => {
  try {
    const { amount } = req.body;

    const options = {
      amount: amount * 100, // Razorpay expects amount in paise (₹1 = 100 paise)
      currency: "INR",
      receipt: `receipt_${Math.floor(Math.random() * 10000)}`,
    };

    const order = await razorpay.orders.create(options);
    res.json(order);
  } catch (error) {
    console.error("Razorpay Error:", error);
    res.status(500).json({ error: "Failed to create Razorpay order" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Pabee Backend running on port ${PORT}`));