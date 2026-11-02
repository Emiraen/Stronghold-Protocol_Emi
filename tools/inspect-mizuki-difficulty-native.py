"""Read-only RO2 difficulty attribute evidence from the installed client DLL."""
import bisect
import json
from pathlib import Path
import struct
import sys

ROOT = Path.cwd()
sys.path.insert(0, str(ROOT / '.cache/mizuki-native-rules/python'))
import capstone
import pefile

DLL = Path('C:/Program Files/Hypergryph Launcher/games/Arknights Game/GameAssembly.dll')
body = DLL.read_bytes()
pe = pefile.PE(data=body, fast_load=True)
base = pe.OPTIONAL_HEADER.ImageBase
off = lambda address: pe.get_offset_from_rva(address - base)
name = body.index(b'Assembly-CSharp.dll\0')
needle = struct.pack('<Q', base + pe.get_rva_from_offset(name))
cursor = 0
while True:
    module = body.find(needle, cursor)
    if module < 0:
        raise ValueError('Assembly-CSharp code module missing')
    count = struct.unpack_from('<I', body, module + 8)[0]
    if 100000 < count < 1000000:
        break
    cursor = module + 1
table = struct.unpack_from('<Q', body, module + 16)[0]
classes = json.loads((ROOT / '.cache/mizuki-native-rules/metadata-index.json').read_text(encoding='utf8'))
methods = {}
for cls in classes:
    if not cls['name'].startswith('Torappu.'):
        continue
    for method in cls['methods']:
        index = (method['token'] & 0xffffff) - 1
        if index < 0 or index >= count:
            continue
        address = struct.unpack_from('<Q', body, off(table + 8 * index))[0]
        if address:
            methods.setdefault(address, []).append(cls['name'] + '::' + method['name'])
addresses = sorted(methods)
decoder = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)
decoder.detail = True
selected = sys.argv[1:] or ['_ApplyFinalAttributes', 'PreprocessEnemy', 'PreProcessCharacter', '_CreateCharBuff', 'PreprocessGlobalBuff', 'PreprocessLevelOptions']
for cls in classes:
    if not cls['name'].startswith('Torappu.Battle.Roguelike.'):
        continue
    for method in cls['methods']:
        if method['name'] not in selected and not any('::' in value and cls['name'].endswith(value.rsplit('::',1)[0]) and method['name']==value.rsplit('::',1)[1] for value in selected):
            continue
        address = struct.unpack_from('<Q', body, off(table + 8 * ((method['token'] & 0xffffff) - 1)))[0]
        next_address = addresses[bisect.bisect_right(addresses, address)]
        length = min(next_address - address, 40000)
        lines = [cls['name'] + '::' + method['name'] + ' token=' + str(method['token']) + ' address=' + hex(address)]
        for instruction in decoder.disasm(body[off(address):off(address) + length], address):
            comments = []
            for operand in instruction.operands:
                if operand.type == capstone.x86.X86_OP_IMM and instruction.mnemonic in ['call', 'jmp']:
                    labels = methods.get(operand.imm, [])
                    comments.extend(labels[:4] + (['...'] if len(labels) > 4 else []))
                if operand.type == capstone.x86.X86_OP_MEM and operand.mem.base == capstone.x86.X86_REG_RIP:
                    target = instruction.address + instruction.size + operand.mem.disp
                    try:
                        data = body[off(target):off(target) + 8]
                        comments.append('rip=' + hex(target) + ' f32=' + str(struct.unpack_from('<f', data)[0]) + ' f64=' + str(struct.unpack_from('<d', data)[0]))
                    except (ValueError, struct.error, pefile.PEFormatError):
                        pass
            lines.append(hex(instruction.address) + ': ' + instruction.mnemonic + ' ' + instruction.op_str + (' ; ' + ' | '.join(comments) if comments else ''))
        path = ROOT / '.cache/mizuki-native-rules' / ('difficulty-' + ('' if cls['name'].endswith('.RoguelikeBattleManager') else cls['name'].rsplit('.',1)[-1]+'-') + method['name'].strip('_') + '.txt')
        path.write_text('\n'.join(lines), encoding='utf8')
        print(path.name, hex(address), len(lines) - 1, 'instructions')
