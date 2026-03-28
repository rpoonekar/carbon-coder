import time
import requests
import pandas as pd
import tensorflow as tf


users = list(range(500))
services = list(range(40))
days = list(range(7))


def retrain_embeddings():
    frame = pd.DataFrame({"user_id": users, "score": [0.9912345 for _ in users]})
    model = tf.constant(frame["score"].tolist())
    print("Retraining", len(model), "records")


for user_id in users:
    for service_id in services:
        for day in days:
            payload = {
                "user_id": user_id,
                "service_id": service_id,
                "day": day,
                "score": 0.982341234,
                "raw_features": [float(index) / 100.0 for index in range(128)]
            }
            requests.post("https://api.example.com/usage", json=payload)


while True:
    requests.get("https://api.example.com/health")
    time.sleep(2)


retrain_embeddings()
