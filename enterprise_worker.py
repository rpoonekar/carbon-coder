import time
import requests
import json
import numpy as np  # Potential anti-pattern: Heavy import
import pandas as pd # Potential anti-pattern: Heavy import

def calculate_simple_metrics():
    # Using massive data science libraries for basic Python math
    # This consumes excess memory and CPU cycles upon import/execution
    basic_prices = [12.99, 15.50, 9.99, 24.00, 5.50]
    max_price = np.max(basic_prices)
    print(f"Highest price today was: {max_price}")

def sync_audit_logs():
    client_list = [{"client_id": i, "tier": "enterprise"} for i in range(200)]
    audit_events = [{"client_id": i, "action": "login", "bytes": 1024} for i in range(50)]

    # ANTI-PATTERN: Greedy O(n^2) loop with unbuffered Network I/O
    for client in client_list:
        for event in audit_events:
            if client["client_id"] == event["client_id"]:
                
                # Dynamic variables: The AST MUST pick up 'client' and 'event'
                dispatch_payload = {
                    "tenant": client["client_id"],
                    "event_type": event["action"],
                    "payload_size": event["bytes"],
                    "timestamp": time.time()
                }
                
                # Sending one request per match instead of batching
                requests.post("https://api.internal.corp/v2/audit/log", json=dispatch_payload)

def watch_deployment_queue():
    # ANTI-PATTERN: Zombie Polling (No exponential backoff or sleep)
    # This will pin a CPU core to 100% and drain energy instantly.
    while True:
        try:
            response = requests.get("https://api.internal.corp/v2/queue/status")
            if response.json().get("jobs_pending") > 0:
                sync_audit_logs()
        except requests.exceptions.RequestException:
            pass 
        # Missing time.sleep() completely!

if __name__ == "__main__":
    calculate_simple_metrics()
    watch_deployment_queue()