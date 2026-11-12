"""Start the OASIS web tool (back end + front end).

Run:  python run_server.py
Open: http://127.0.0.1:8000

The server only listens on this computer (127.0.0.1). To let other devices
on the network use it, change HOST to "0.0.0.0" - but note it has no login.
"""
import uvicorn

HOST = "127.0.0.1"
PORT = 8000

if __name__ == "__main__":
    uvicorn.run("backend.main:app", host=HOST, port=PORT)
