import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');
  
  // 1. Create the Vendor matching your App.tsx dummy ID
const vendor = await prisma.vendor.upsert({
  where: { id: "123e1f00-f219-4383-b01b-e06b83f351dd" }, // or whatever your seed ID is
  update: {},
  create: {
    id: "123e1f00-f219-4383-b01b-e06b83f351dd",
    name: "Demo Stall",
    businessType: "Food & Beverage",
    defaultTable: "Counter",
    tier: 1,

    // 🚨 ADD THESE TWO REQUIRED FIELDS:
    clerkId: "user_seed_test_clerk_id", // Dummy Clerk ID for local testing
    email: "demo-vendor@pabee.internal" // Unique email for this vendor
  }
});

  // 2. Create some Menu Items attached to that vendor
  await prisma.menuItem.createMany({
    data: [
      {
        vendorId: vendor.id,
        name: 'Pav Bhaji',
        category: 'Food',
        price: 80,
        prep: '10 min',
        veg: true,
      },
      {
        vendorId: vendor.id,
        name: 'Vada Pav',
        category: 'Snacks',
        price: 25,
        prep: '5 min',
        veg: true,
      }
    ]
  });

  console.log('✅ Successfully added Spice Street Kitchen and its menu!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });