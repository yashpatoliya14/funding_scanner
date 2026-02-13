from bot import load_coindcx_funding
import json

try:
    funding = load_coindcx_funding()
    print(f"Loaded {len(funding)} pairs from CoinDCX")
    
    # Check a few pairs
    count = 0
    for sym, data in funding.items():
        print(f"{sym}: {data}")
        count += 1
        if count >= 3:
            break
            
except Exception as e:
    print(f"Error: {e}")
