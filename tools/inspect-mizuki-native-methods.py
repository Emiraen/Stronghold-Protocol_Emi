"""Read-only original GameAssembly evidence scoped by exact class names."""
import json
from pathlib import Path
import struct
import sys
from bisect import bisect_right

ROOT = Path.cwd()
sys.path.insert(0, str(ROOT / '.cache/mizuki-native-rules/python'))
import capstone
import pefile


def inspect(names, destination):
    binary = Path('C:/Program Files/Hypergryph Launcher/games/Arknights Game/GameAssembly.dll').read_bytes()
    pe = pefile.PE(data=binary, fast_load=True)
    base = pe.OPTIONAL_HEADER.ImageBase
    def offset(address):
        return pe.get_offset_from_rva(address-base)
    name_offset = binary.index(b'Assembly-CSharp.dll\0')
    needle = struct.pack('<Q', base + pe.get_rva_from_offset(name_offset))
    start = 0
    while True:
        module = binary.find(needle, start)
        if module < 0:
            raise ValueError('Original Assembly-CSharp code registration missing')
        count = struct.unpack_from('<I', binary, module+8)[0]
        if 100000 < count < 1000000:
            break
        start = module+1
    table = struct.unpack_from('<Q', binary, module+16)[0]
    classes = json.loads((ROOT / '.cache/mizuki-native-rules/metadata-index.json').read_text('utf8'))
    selected = [c for c in classes if c['name'] in names]
    addresses = {}
    for c in classes:
        if not c['name'].startswith('Torappu.'):
            continue
        for method in c['methods']:
            index = (method['token'] & 0xffffff)-1
            if index < 0 or index >= count:
                continue
            try:
                address = struct.unpack_from('<Q', binary, offset(table+8*index))[0]
            except (ValueError, struct.error):
                continue
            if address:
                addresses.setdefault(address, []).append(c['name']+'::'+method['name'])
    ordered = sorted(addresses)
    output=[]
    decoder = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)
    decoder.detail=True
    for c in selected:
        output.append(json.dumps(c, ensure_ascii=False))
        for method in c['methods']:
            address = struct.unpack_from('<Q', binary, offset(table+8*((method['token'] & 0xffffff)-1)))[0]
            if not address:
                continue
            at=bisect_right(ordered,address)
            size=min(24000, ordered[at]-address if at<len(ordered) else 4000)
            output.append('\n'+c['name']+'::'+method['name']+' '+hex(address)+' bytes='+str(size))
            for ins in decoder.disasm(binary[offset(address):offset(address)+size],address):
                annotation=[]
                if ins.mnemonic in ('call','jmp') and ins.operands and ins.operands[0].type==capstone.x86.X86_OP_IMM:
                    target=ins.operands[0].imm
                    if target in addresses:
                        annotation.append('|'.join(addresses[target][:3]))
                for operand in ins.operands:
                    if operand.type==capstone.x86.X86_OP_MEM and operand.mem.base==capstone.x86.X86_REG_RIP:
                        target=ins.address+ins.size+operand.mem.disp
                        try:
                            pos=offset(target)
                            if ins.mnemonic in ('movss','mulss','addss','subss','comiss','ucomiss'):
                                annotation.append('float='+str(struct.unpack_from('<f',binary,pos)[0]))
                        except (ValueError,struct.error):
                            pass
                output.append(hex(ins.address)+' '+ins.mnemonic+' '+ins.op_str+(' ; '+', '.join(annotation) if annotation else ''))
    destination.parent.mkdir(parents=True,exist_ok=True)
    destination.write_text('\n'.join(output),encoding='utf8')
    return {'classes':len(selected),'methods':sum(len(c['methods']) for c in selected),'file':str(destination),'lines':len(output)}


if __name__=='__main__':
    if len(sys.argv)<3:
        raise SystemExit('usage: script output.txt ExactClassName [MoreClassNames...]')
    print(json.dumps(inspect(sys.argv[2:],ROOT / sys.argv[1])))
