// File location: scripts/seedData.js

require("dotenv").config();

const pool = require("../src/config/db");
const { faker } = require("@faker-js/faker");

const CATEGORIES = [
  "Groceries",
  "Utilities",
  "Rent",
  "Salary",
  "Shopping",
  "Transfer",
  "Education",
];

async function seedDatabase() {
  console.log("🌱 Starting Database Seeding Process...");

  try {
    // Fetch all existing customer usernames
    const customerRes = await pool.query("SELECT username FROM customers");
    if (customerRes.rowCount < 2) {
      console.error(
        "❌ Need at least 2 registered customers in the DB to generate transfers between users!",
      );
      process.exit(1);
    }

    const customers = customerRes.rows.map((r) => r.username);
    console.log(
      `Found ${customers.length} customers: [${customers.join(", ")}]. Generating transactions...`,
    );

    let totalInserted = 0;

    // Generate ~100 historical transactions per user
    for (const senderUser of customers) {
      for (let i = 0; i < 100; i++) {
        // Pick a receiver that isn't the sender
        const possibleReceivers = customers.filter((u) => u !== senderUser);
        const receiverUser = faker.helpers.arrayElement(possibleReceivers);

        // Generate timestamps spread across the last 180 days
        const timestamp = faker.date.recent({ days: 180 });
        const category = faker.helpers.arrayElement(CATEGORIES);
        const txnId = `TXN-${faker.string.alphanumeric({ length: 10, casing: "upper" })}`;

        // 95% normal transfers, 5% high-amount suspicious outliers
        const isSuspicious = Math.random() < 0.05;
        let amount;
        let riskScore = 0;
        let status = "APPROVED";
        let isVerified = false;

        if (isSuspicious) {
          amount = faker.number.int({ min: 75000, max: 250000 });
          riskScore = faker.number.int({ min: 75, max: 98 });
          status = Math.random() > 0.5 ? "PENDING_REVIEW" : "APPROVED";
          isVerified = false;
        } else {
          amount = faker.number.int({ min: 100, max: 15000 });
          riskScore = faker.number.int({ min: 0, max: 30 });
          status = "APPROVED";
          isVerified = Math.random() > 0.5;
        }

        await pool.query(
          `INSERT INTO transactions 
           (txn_id, sender, receiver, amount, status, timestamp, category, risk_score, is_verified_merchant)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            txnId,
            senderUser,
            receiverUser,
            amount,
            status,
            timestamp,
            category,
            riskScore,
            isVerified,
          ],
        );

        totalInserted++;
      }
    }

    console.log(
      `✅ Success! Inserted ${totalInserted} realistic historical transactions matching your schema into Neon DB.`,
    );
    process.exit(0);
  } catch (error) {
    console.error("❌ Error seeding database:", error);
    process.exit(1);
  }
}

seedDatabase();
