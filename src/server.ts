import express from 'express';
import jwt from 'jsonwebtoken';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';
import Razorpay from 'razorpay';

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

// 8. Vendor Login (Authentication)
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-local-key';

app.post('/api/vendors/login', async (req, res) => {
  const { vendorId, passcode } = req.body;
  try {
    const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
    
    // In production, NEVER store plain text passwords. You would use bcrypt.compare() here.
    if (vendor && vendor.passcode === passcode) {
      // Generate a token that expires in 12 hours
      const token = jwt.sign({ vendorId: vendor.id, role: 'vendor' }, JWT_SECRET, { expiresIn: '12h' });
      res.json({ success: true, token });
    } else {
      res.status(401).json({ error: 'Invalid Vendor ID or Passcode' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Server error during login' });
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