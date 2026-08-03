// File location: src/services/mlService.js

import axios from "axios";

const ML_SERVICE_URL = process.env.ML_SERVICE_URL || "http://127.0.0.1:5000";

/**
 * Communicates with the Python FastAPI ML microservice.
 * @param {Object} params
 * @param {number} params.amount - Transaction amount
 * @param {number} params.hour - Hour of transaction (0-23)
 * @param {number} params.recentCount - Sender txns in last 10 mins
 * @param {number} params.isVerified - Recipient verification status (1 or 0)
 * @returns {Promise<Object>} { risk_score, is_high_risk }
 */
export const getTransactionRiskScore = async ({
  amount,
  hour,
  recentCount,
  isVerified,
}) => {
  try {
    const response = await axios.post(
      `${ML_SERVICE_URL}/predict`,
      {
        amount: Number(amount),
        hour: Number(hour),
        recent_count: Number(recentCount),
        is_verified: Number(isVerified),
      },
      { timeout: 3000 },
    ); // 3s strict timeout for real-time banking standard

    return response.data;
  } catch (error) {
    console.error("ML Service Error:", error.message);
    // Explicitly throw so route controller can handle engine outage
    throw new Error("ML_SERVICE_UNAVAILABLE");
  }
};
