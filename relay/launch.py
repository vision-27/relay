"""Absolute-path entrypoint so agent clients need no pip install or special cwd."""
import sys
from pathlib import Path

if __name__ == '__main__':
    # Preserve Homebrew's stable opt path so printed MCP commands survive upgrades.
    sys.path.insert(0, str(Path(__file__).absolute().parents[1]))
    from relay.__main__ import main
    main()
