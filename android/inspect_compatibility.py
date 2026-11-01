import json, ssl, socket, struct, zipfile
from prepare_assets import WORK

def elf_loads(stream):
    header = stream.read(64)
    assert header[:4] == b'\x7fELF'
    endian = '<' if header[5] == 1 else '>'
    bits = header[4]
    phoff = struct.unpack_from(endian + ('Q' if bits == 2 else 'I'), header, 32 if bits == 2 else 28)[0]
    entsize, count = struct.unpack_from(endian + 'HH', header, 54 if bits == 2 else 42)
    stream.seek(phoff)
    table = stream.read(entsize * count)
    aligns = []
    for n in range(count):
        p = table[n * entsize:(n + 1) * entsize]
        if struct.unpack_from(endian + 'I', p)[0] == 1:
            aligns.append(struct.unpack_from(endian + ('Q' if bits == 2 else 'I'), p, 48 if bits == 2 else 28)[0])
    return aligns

if __name__ == '__main__':
    with zipfile.ZipFile(WORK / 'downloads/geckoview-compatible.aar') as z:
        native = {i.filename: elf_loads(z.open(i)) for i in z.infolist() if i.filename.endswith('.so')}
    print(json.dumps({'native':native}))
    for host, port in [('super.emiraen.top',23331),('emiraen.top',443)]:
        with socket.create_connection((host,port),timeout=15) as sock:
            with ssl.create_default_context().wrap_socket(sock,server_hostname=host) as secure:
                cert = secure.getpeercert()
                print(json.dumps({'host':host,'issuer':cert.get('issuer'),'expires':cert.get('notAfter')}))
