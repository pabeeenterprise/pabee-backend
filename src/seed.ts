import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');
  
  // 1. Create the Vendor matching your App.tsx dummy ID
  const vendor = await prisma.vendor.create({
    data: {
      id: 'spice-street-kitchen',
      name: 'Spice Street Kitchen',
      businessType: 'Street Food',
      defaultTable: '4',
      tier: 1,
    },
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