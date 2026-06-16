import subprocess

def get_active_ports():
    """
    Scans for active listening ports on localhost using lsof (works on macOS/Linux).
    """
    ports = []
    try:
        output = subprocess.check_output(['lsof', '-i', '-P', '-n'], text=True)
        for line in output.splitlines():
            if 'LISTEN' in line:
                parts = line.split()
                if len(parts) >= 9:
                    process = parts[0]
                    pid = parts[1]
                    address = parts[8]
                    if ':' in address:
                        port = address.split(':')[-1]
                        # De-duplicate
                        if not any(p["port"] == port for p in ports):
                            ports.append({"process": process, "pid": pid, "port": port})
    except Exception as e:
        print(f"Error scanning ports: {e}")
        
    return ports
