# File location: ml_service/train_model.py

import numpy as np
import pandas as pd
import joblib
from sklearn.model_selection import train_test_split
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import classification_report, accuracy_score

# 1. Generate Synthetic Banking Transaction Dataset for Training
np.random.seed(42)
n_samples = 5000

# Features: [amount, transaction_hour, recent_10min_count, is_verified_merchant]
amounts = np.random.exponential(scale=10000, size=n_samples)
hours = np.random.randint(0, 24, size=n_samples)
recent_counts = np.random.poisson(lam=1.5, size=n_samples)
is_verified = np.random.choice([0, 1], size=n_samples, p=[0.3, 0.7])

# Generate Target Label (1 = Fraud/High Risk, 0 = Legitimate) based on statistical interactions
risk_probability = (
    (amounts / 100000) * 0.4 +
    ((hours >= 1) & (hours <= 5)).astype(int) * 0.25 +
    (recent_counts / 5) * 0.25 +
    (1 - is_verified) * 0.1
) + np.random.normal(0, 0.05, size=n_samples)

labels = (risk_probability > 0.45).astype(int)

# Create Pandas DataFrame
df = pd.DataFrame({
    'amount': amounts,
    'hour': hours,
    'recent_count': recent_counts,
    'is_verified': is_verified,
    'is_fraud': labels
})

X = df[['amount', 'hour', 'recent_count', 'is_verified']]
y = df['is_fraud']

# 2. Train / Test Split
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

# 3. Train Random Forest Classifier
print("Training Random Forest Classifier model...")
clf = RandomForestClassifier(n_estimators=100, max_depth=10, random_state=42)
clf.fit(X_train, y_train)

# 4. Evaluate Model Metrics
y_pred = clf.predict(X_test)
print(f"\n--- Model Accuracy: {accuracy_score(y_test, y_pred) * 100:.2f}% ---")
print("\nClassification Report:\n", classification_report(y_test, y_pred))

# 5. Export Trained Model
joblib.dump(clf, "fraud_model.pkl")
print("Model saved successfully as ml_service/fraud_model.pkl!")