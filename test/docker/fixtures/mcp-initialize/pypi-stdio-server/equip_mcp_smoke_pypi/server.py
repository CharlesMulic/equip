import json
import sys


def main() -> None:
    for line in sys.stdin:
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue

        if message.get("method") != "initialize":
            continue

        response = {
            "jsonrpc": "2.0",
            "id": message.get("id"),
            "result": {
                "protocolVersion": message.get("params", {}).get("protocolVersion", "2025-06-18"),
                "capabilities": {"tools": {}},
                "serverInfo": {
                    "name": "equip-mcp-smoke-pypi",
                    "version": "0.1.0",
                },
            },
        }
        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
