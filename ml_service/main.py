# File location: ml_service/main.py

from fastapi import FastAPI
from pydantic import BaseModel
import joblib
import pandas as pd

app = FastAPI(title="Bank of Vellorian - Fraud Detection ML Service")

# Load the trained Random Forest model into memory
model = joblib.load("fraud_model.pkl")

# Define input structure for incoming API requests
class TransactionFeatures(BaseModel):
    amount: float
    hour: int
    recent_count: int
    is_verified: int

@app.post("/predict")
def predict_risk(txn: TransactionFeatures):
    # 1. Format incoming features into Pandas DataFrame
    input_data = pd.DataFrame([{
        'amount': txn.amount,
        'hour': txn.hour,
        'recent_count': txn.recent_count,
        'is_verified': txn.is_verified
    }])
    
    # 2. Run model inference to get class probabilities [prob_legit, prob_fraud]
    probabilities = model.predict_proba(input_data)[0]
    fraud_probability = float(probabilities[1])  # Class 1 = Fraud / High Risk
    
    # 3. Convert probability to 0-100 risk score
    risk_score = round(fraud_probability * 100)
    
    return {
        "risk_score": risk_score,
        "fraud_probability": round(fraud_probability, 4),
        "is_high_risk": risk_score >= 60
    }

@app.get("/health")
def health_check():
    return {"status": "ML Engine Online"}