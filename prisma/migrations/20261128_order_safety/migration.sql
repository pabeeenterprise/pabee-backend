-- CreateTable
CREATE TABLE "VendorDailyCounter" (
    "vendorId" TEXT NOT NULL,
    "dateKey" TEXT NOT NULL,
    "lastToken" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "VendorDailyCounter_pkey" PRIMARY KEY ("vendorId","dateKey")
);
