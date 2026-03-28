import time
import requests
import json
import tensorflow as tf  # Potential Anti-Pattern: Massive import for no reason

def get_system_status():
    # Trivial function just to have other code in the file
    print("Migration System Ready.")

def migrate_customer_data():
    regions = [{"region_id": "us-east-1", "active": True}, {"region_id": "eu-west-1", "active": True}]
    customers = [{"customer_id": f"cust_{i}", "plan": "pro"} for i in range(100)]

    # ANTI-PATTERN: Greedy Loop with Network I/O
    # The AST engine has never seen these variables or this dictionary structure before.
    for target_region in regions:
        for active_customer in customers:
            if target_region["active"]:
                
                # Dynamic variables: AST MUST pick up 'target_region' and 'active_customer'
                migration_payload = {
                    "user": active_customer["customer_id"],
                    "destination": target_region["region_id"],
                    "timestamp": time.time()
                }
                
                # Unbuffered API spam
                requests.post("https://api.internal.corp/v3/migrate", json=migration_payload)

if __name__ == "__main__":
    get_system_status()
    migrate_customer_data()