import http.server, os, sys
os.chdir('/Users/dimostzo/Desktop/BusinessMastermind')
handler = http.server.SimpleHTTPRequestHandler
with http.server.HTTPServer(('', 5500), handler) as httpd:
    httpd.serve_forever()
