#!/usr/bin/env python3
"""
GPU Memory Occupation Script
Allocates and maintains GPU memory usage for resource reservation.
Usage: python occupy_gpu.py --gpus 0,1,2 --memory 40 [--duration 3600]
"""

import argparse
import sys
import time
import signal
import os

def check_dependencies():
    """Check if PyTorch is available."""
    try:
        import torch
        if not torch.cuda.is_available():
            print("Error: CUDA is not available. Check your GPU drivers.", file=sys.stderr)
            sys.exit(1)
        return torch
    except ImportError:
        print("Error: PyTorch is not installed. Install with: pip install torch", file=sys.stderr)
        sys.exit(1)

def parse_args():
    parser = argparse.ArgumentParser(description='GPU Memory Occupation Utility')
    parser.add_argument('--gpus', type=str, required=True,
                        help='Comma-separated GPU IDs (e.g., 0,1,2)')
    parser.add_argument('--memory', type=float, required=True,
                        help='Memory to allocate per GPU in GB')
    parser.add_argument('--duration', type=int, default=0,
                        help='Duration in seconds (0 = indefinite)')
    return parser.parse_args()

def allocate_memory(torch, gpu_id, memory_gb):
    """Allocate memory on a specific GPU."""
    try:
        device = torch.device(f'cuda:{gpu_id}')
        # Calculate number of float32 elements (4 bytes each)
        num_elements = int((memory_gb * 1024 * 1024 * 1024) / 4)
        # Allocate tensor
        tensor = torch.zeros(num_elements, dtype=torch.float32, device=device)
        # Do a small computation to ensure allocation
        tensor += 1
        return tensor
    except RuntimeError as e:
        if "out of memory" in str(e).lower():
            print(f"Error: Not enough memory on GPU {gpu_id} to allocate {memory_gb}GB", file=sys.stderr)
        else:
            print(f"Error allocating memory on GPU {gpu_id}: {e}", file=sys.stderr)
        return None

def main():
    args = parse_args()
    torch = check_dependencies()

    # Parse GPU IDs
    try:
        gpu_ids = [int(x.strip()) for x in args.gpus.split(',')]
    except ValueError:
        print("Error: Invalid GPU IDs. Use comma-separated integers (e.g., 0,1,2)", file=sys.stderr)
        sys.exit(1)

    # Validate GPU IDs
    num_gpus = torch.cuda.device_count()
    for gpu_id in gpu_ids:
        if gpu_id < 0 or gpu_id >= num_gpus:
            print(f"Error: GPU {gpu_id} not found. Available GPUs: 0-{num_gpus-1}", file=sys.stderr)
            sys.exit(1)

    print(f"Allocating {args.memory}GB on GPUs: {gpu_ids}")

    # Allocate memory on each GPU
    tensors = []
    for gpu_id in gpu_ids:
        print(f"  Allocating on GPU {gpu_id}...", end=' ', flush=True)
        tensor = allocate_memory(torch, gpu_id, args.memory)
        if tensor is None:
            # Cleanup already allocated
            tensors.clear()
            sys.exit(1)
        tensors.append(tensor)
        print("OK")

    print(f"\nMemory allocated successfully. Holding GPUs: {gpu_ids}")
    if args.duration > 0:
        print(f"Will release after {args.duration} seconds.")
    else:
        print("Press Ctrl+C to release.")

    # Setup signal handler for graceful exit
    def signal_handler(sig, frame):
        print("\nReleasing GPU memory...")
        tensors.clear()
        torch.cuda.empty_cache()
        print("Done.")
        sys.exit(0)

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    # Keep running
    start_time = time.time()
    try:
        while True:
            time.sleep(10)
            # Periodic activity to look like a normal program
            for t in tensors:
                t += 0.0001
                t -= 0.0001

            if args.duration > 0 and (time.time() - start_time) >= args.duration:
                print(f"\nDuration reached ({args.duration}s). Releasing memory...")
                break
    except KeyboardInterrupt:
        pass

    # Cleanup
    tensors.clear()
    torch.cuda.empty_cache()
    print("GPU memory released.")

if __name__ == '__main__':
    main()
