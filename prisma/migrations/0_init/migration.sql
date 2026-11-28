-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "public"."PaymentType" AS ENUM ('UPI', 'RAZORPAY');

-- CreateTable
CREATE TABLE "public"."DailyExpense" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyExpense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."InventoryItem" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "currentStock" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "minAlert" DOUBLE PRECISION NOT NULL DEFAULT 100,
    "costPerUnit" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."MenuItem" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "prep" TEXT NOT NULL,
    "veg" BOOLEAN NOT NULL DEFAULT true,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "imageUrl" TEXT,
    "badgeLabel" TEXT,
    "costPrice" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "description" TEXT,
    "emoji" TEXT,
    "remarks" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MenuItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Order" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "tableId" TEXT,
    "token" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'received',
    "kitchenStatus" TEXT NOT NULL DEFAULT 'pending',
    "total" DOUBLE PRECISION NOT NULL,
    "paymentMode" TEXT NOT NULL,
    "customerPhone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "customerName" TEXT NOT NULL DEFAULT 'Walk-in',
    "razorpayOrderId" TEXT,
    "razorpayPaymentId" TEXT,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."OrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PaymentData" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "upiId" TEXT,
    "paymentType" "public"."PaymentType" NOT NULL DEFAULT 'UPI',
    "qrImagePath" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "razorpayKeyId" TEXT,
    "razorpayKeySecret" TEXT,

    CONSTRAINT "PaymentData_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Promo" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "minOrderValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "maxUses" INTEGER,
    "currentUses" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "applyTo" TEXT NOT NULL DEFAULT 'ALL',

    CONSTRAINT "Promo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."RecipeItem" (
    "id" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "quantityUsed" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "RecipeItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Vendor" (
    "id" TEXT NOT NULL,
    "clerkId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "businessType" TEXT,
    "tier" INTEGER NOT NULL DEFAULT 1,
    "defaultTable" TEXT NOT NULL DEFAULT 'Counter',
    "bannerUrl" TEXT,
    "logoUrl" TEXT,
    "accentColor" TEXT NOT NULL DEFAULT '#E5B35C',
    "buttonRoundness" TEXT NOT NULL DEFAULT 'rounded-xl',
    "fontFamily" TEXT NOT NULL DEFAULT 'font-sans',
    "themeMode" TEXT NOT NULL DEFAULT 'dark',
    "offerText" TEXT,
    "showOfferStrip" BOOLEAN NOT NULL DEFAULT false,
    "dashboardLogoUrl" TEXT,
    "storeName" TEXT NOT NULL DEFAULT 'Unnamed Store',
    "useLogoAsHeader" BOOLEAN NOT NULL DEFAULT false,
    "address" TEXT,
    "masterPin" TEXT,

    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DailyExpense_vendorId_date_idx" ON "public"."DailyExpense"("vendorId" ASC, "date" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "InventoryItem_vendorId_name_key" ON "public"."InventoryItem"("vendorId" ASC, "name" ASC);

-- CreateIndex
CREATE INDEX "MenuItem_vendorId_available_idx" ON "public"."MenuItem"("vendorId" ASC, "available" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Order_razorpayOrderId_key" ON "public"."Order"("razorpayOrderId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Order_razorpayPaymentId_key" ON "public"."Order"("razorpayPaymentId" ASC);

-- CreateIndex
CREATE INDEX "Order_vendorId_createdAt_idx" ON "public"."Order"("vendorId" ASC, "createdAt" ASC);

-- CreateIndex
CREATE INDEX "Order_vendorId_kitchenStatus_createdAt_idx" ON "public"."Order"("vendorId" ASC, "kitchenStatus" ASC, "createdAt" ASC);

-- CreateIndex
CREATE INDEX "OrderItem_orderId_idx" ON "public"."OrderItem"("orderId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentData_vendorId_key" ON "public"."PaymentData"("vendorId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Promo_vendorId_code_key" ON "public"."Promo"("vendorId" ASC, "code" ASC);

-- CreateIndex
CREATE INDEX "RecipeItem_inventoryItemId_idx" ON "public"."RecipeItem"("inventoryItemId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "RecipeItem_menuItemId_inventoryItemId_key" ON "public"."RecipeItem"("menuItemId" ASC, "inventoryItemId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Vendor_clerkId_key" ON "public"."Vendor"("clerkId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Vendor_email_key" ON "public"."Vendor"("email" ASC);

-- AddForeignKey
ALTER TABLE "public"."DailyExpense" ADD CONSTRAINT "DailyExpense_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."InventoryItem" ADD CONSTRAINT "InventoryItem_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MenuItem" ADD CONSTRAINT "MenuItem_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Order" ADD CONSTRAINT "Order_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "public"."Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PaymentData" ADD CONSTRAINT "PaymentData_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Promo" ADD CONSTRAINT "Promo_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RecipeItem" ADD CONSTRAINT "RecipeItem_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "public"."InventoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RecipeItem" ADD CONSTRAINT "RecipeItem_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "public"."MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
