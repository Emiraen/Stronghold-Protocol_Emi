import concurrent.futures, json, socket, ssl, urllib.request, urllib.error

ORIGIN = 'http://127.0.0.1:18647'
TARGETS = [('super.emiraen.top',23331), ('super.emiraen.top',443), ('emiraen.top',443)]

def check(target):
    host, port = target
    base = 'https://' + host + (':' + str(port) if port != 443 else '')
    result = {'url':base}
    for path in ['/api/servers','/healthz']:
        try:
            with urllib.request.urlopen(urllib.request.Request(base + path, headers={'User-Agent':'Stronghold-Android/20261025','Origin':ORIGIN}),timeout=8) as r:
                body = r.read(32768).decode('utf-8','replace')
                data = json.loads(body)
                result[path] = {'status':r.status,'body':data if path.endswith('servers') else {k:data.get(k) for k in ['ok','version','build','serverId']}}
        except Exception as e: result[path] = {'error':str(e)}
    try:
        with socket.create_connection((host,port),timeout=8) as tcp:
            with ssl.create_default_context().wrap_socket(tcp,server_hostname=host) as sock:
                sock.sendall(('GET /ws HTTP/1.1\r\nHost: '+host+(':'+str(port) if port != 443 else '')+'\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: '+ORIGIN+'\r\nUser-Agent: Stronghold-Android/20261025\r\n\r\n').encode('ascii'))
                result['websocket'] = sock.recv(4096).decode('utf-8','replace').split('\r\n\r\n')[0]
    except Exception as e: result['websocket'] = {'error':str(e)}
    return result

if __name__ == '__main__':
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        for result in pool.map(check,TARGETS): print(json.dumps(result,ensure_ascii=False),flush=True)
