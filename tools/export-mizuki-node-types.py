"""Export original IL2CPP RoguelikeEventType constants, not enum field order."""
import hashlib
import json
from pathlib import Path
import struct

source = Path('C:/Program Files/Hypergryph Launcher/games/Arknights Game/Arknights_Data/il2cpp_data/Metadata/global-metadata.dat')
data = source.read_bytes()
def pair(offset):
    return struct.unpack_from('<II', data, offset)
def records(offset, fmt):
    start, length = pair(offset)
    size = struct.calcsize(fmt)
    return [struct.unpack_from(fmt, data, at) for at in range(start, start + length, size)]
string_start, _ = pair(24)
def string(offset):
    at = string_start + offset
    return data[at:data.index(b'\0', at)].decode('utf8')
def compressed_int(at):
    first = data[at]
    if first < 0x80:
        value, size = first, 1
    elif first < 0xc0:
        value, size = ((first & 0x3f) << 8) | data[at + 1], 2
    elif first < 0xe0:
        value, size = ((first & 0x1f) << 24) | int.from_bytes(data[at + 1:at + 4], 'big'), 4
    elif first == 0xf0:
        value, size = int.from_bytes(data[at + 1:at + 5], 'little'), 5
    else:
        raise ValueError('Unsupported original compressed constant prefix: ' + hex(first))
    return (value >> 1) ^ -(value & 1), data[at:at + size].hex()
fields = records(96, '<III')
defaults = {item[0]: item for item in records(64, '<III')}
default_start, default_length = pair(72)
enum = next(item for item in records(160, '<16I8H2I')
    if string(item[0]) == 'RoguelikeEventType' and string(item[1]) == 'Torappu')
values, encoded = {}, {}
for index in range(enum[8], enum[8] + enum[18]):
    default = defaults.get(index)
    if default is None:
        continue
    assert default[2] < default_length
    name = string(fields[index][0])
    values[name], encoded[name] = compressed_int(default_start + default[2])
result = {'enum': 'Torappu.RoguelikeEventType', 'source': str(source),
    'sourceSha256': hashlib.sha256(data).hexdigest(), 'values': values, 'encodedConstants': encoded}
out = Path('public/assets/mizuki/native-ui-motion/node-types.json')
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + chr(10), encoding='utf8')
print(json.dumps(values, ensure_ascii=False))
