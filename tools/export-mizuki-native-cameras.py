"""Export RO2's original camera inputs without changing scene/map manifests."""
import hashlib
import json
from pathlib import Path
import struct
import sys
import types

ROOT = Path.cwd()
sys.path.insert(0, str(ROOT / 'tools/local-extract'))
sys.path.insert(1, str(ROOT / '.tmp-mod-analysis-20261025/pipe-render-hotfix-20261025/pydeps'))
sys.path.insert(2, str(ROOT / '.cache/mizuki-native-rules/python'))
sys.modules.setdefault('fmod_toolkit', types.ModuleType('fmod_toolkit'))
sys.modules['numpy'] = None
import aklz4  # noqa: E402,F401
import fx  # noqa: E402
import capstone  # noqa: E402
import pefile  # noqa: E402

CLIENT_ROOT = Path('C:/Program Files/Hypergryph Launcher/games/Arknights Game')
CLIENT = CLIENT_ROOT / 'Arknights_Data/StreamingAssets/AB/Windows'
MAPS = ROOT / 'public/assets/mizuki/native-maps'
OUT = ROOT / 'public/assets/mizuki/native-cameras'


def read(path):
    return json.loads(path.read_text(encoding='utf8'))


def portable(value, field=''):
    if isinstance(value, int) and (field == 'm_PathID' or abs(value) > 9007199254740991):
        return str(value)
    if isinstance(value, dict):
        return {key: portable(child, key) for key, child in value.items()}
    if isinstance(value, (list, tuple)):
        return [portable(child) for child in value]
    return value


def sha(body):
    return hashlib.sha256(body).hexdigest()


def multiply(a, b):
    return [[sum(a[r][k] * b[k][c] for k in range(4)) for c in range(4)] for r in range(4)]


def inverse(a):
    rows = [list(row) + [float(r == c) for c in range(4)] for r, row in enumerate(a)]
    for col in range(4):
        pivot = max(range(col, 4), key=lambda r: abs(rows[r][col]))
        rows[col], rows[pivot] = rows[pivot], rows[col]
        scale = rows[col][col]
        if abs(scale) < 1e-12:
            raise ValueError('Singular original transform')
        rows[col] = [value / scale for value in rows[col]]
        for row in range(4):
            if row != col:
                factor = rows[row][col]
                rows[row] = [value - factor * other for value, other in zip(rows[row], rows[col])]
    return [row[4:] for row in rows]


def compose(pos, quat, scale):
    x, y, z, w = quat
    return [
        [(1 - 2 * (y*y+z*z)) * scale[0], 2 * (x*y-z*w) * scale[1], 2 * (x*z+y*w) * scale[2], pos[0]],
        [2 * (x*y+z*w) * scale[0], (1 - 2 * (x*x+z*z)) * scale[1], 2 * (y*z-x*w) * scale[2], pos[1]],
        [2 * (x*z-y*w) * scale[0], 2 * (y*z+x*w) * scale[1], (1 - 2 * (x*x+y*y)) * scale[2], pos[2]],
        [0, 0, 0, 1],
    ]


def point(matrix, value):
    return [sum(matrix[r][c] * value[c] for c in range(3)) + matrix[r][3] for r in range(3)]


def original_presets():
    """Read CAMERA_VIEWS from the actual Consts cctor's scalar stores."""
    binary = (CLIENT_ROOT / 'GameAssembly.dll').read_bytes()
    pe = pefile.PE(data=binary, fast_load=True)
    base = pe.OPTIONAL_HEADER.ImageBase
    offset = lambda address: pe.get_offset_from_rva(address - base)  # noqa: E731
    name_offset = binary.index(b'Assembly-CSharp.dll\0')
    needle = struct.pack('<Q', base + pe.get_rva_from_offset(name_offset))
    start = 0
    while True:
        module = binary.find(needle, start)
        if module < 0:
            raise ValueError('Original Assembly-CSharp module unavailable')
        count = struct.unpack_from('<I', binary, module + 8)[0]
        if 100000 < count < 1000000:
            break
        start = module + 1
    table = struct.unpack_from('<Q', binary, module + 16)[0]
    classes = read(ROOT / '.cache/mizuki-native-rules/metadata-index.json')
    consts = next(c for c in classes if c['name'] == 'Torappu.Battle.Consts')
    token = next(m['token'] for m in consts['methods'] if m['name'] == '.cctor') & 0xffffff
    address = struct.unpack_from('<Q', binary, offset(table + 8 * (token - 1)))[0]
    decoder = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)
    decoder.detail = True
    registers, values, stores = {}, {}, []
    for ins in decoder.disasm(binary[offset(address):offset(address)+1500], address):
        operands = ins.operands
        if ins.mnemonic == 'xorps' and len(operands) == 2 and operands[0].reg == operands[1].reg:
            registers[operands[0].reg] = [0.0] * 4
        elif ins.mnemonic == 'movss' and operands[0].type == capstone.x86.X86_OP_REG and operands[1].type == capstone.x86.X86_OP_MEM and operands[1].mem.base == capstone.x86.X86_REG_RIP:
            source = ins.address + ins.size + operands[1].mem.disp
            registers[operands[0].reg] = [struct.unpack_from('<f', binary, offset(source))[0], 0.0, 0.0, 0.0]
        elif ins.mnemonic == 'unpcklps' and operands[0].reg in registers and operands[1].reg in registers:
            a, b = registers[operands[0].reg], registers[operands[1].reg]
            registers[operands[0].reg] = [a[0], b[0], a[1], b[1]]
        elif ins.mnemonic in ('movss', 'movsd') and operands[0].type == capstone.x86.X86_OP_MEM and operands[0].mem.base == capstone.x86.X86_REG_RAX and operands[1].reg in registers:
            index = (operands[0].mem.disp - 0x20) // 4
            if index < 0 or index >= 15:
                continue
            size = 1 if ins.mnemonic == 'movss' else 2
            for n in range(size):
                values[index+n] = registers[operands[1].reg][n]
            stores.append({'instruction': hex(ins.address), 'firstFloat': index, 'floatCount': size})
            if len(values) == 15:
                break
    if set(values) != set(range(15)):
        raise ValueError('Original CAMERA_VIEWS initializer shape changed')
    names = ['DEFAULT', 'MAX', 'MEDIUM', 'ULTIMATE', 'UP']
    return [{'value': i, 'name': name, 'position': [values[i*3+j] for j in range(3)]} for i, name in enumerate(names)], {
        'file': 'GameAssembly.dll', 'sha256': sha(binary), 'method': 'Torappu.Battle.Consts::.cctor', 'methodAddress': hex(address), 'stores': stores,
    }


def run():
    manifest = read(MAPS / 'manifest.json')
    presets, preset_source = original_presets()
    env = fx.AssetEnv(CLIENT, read(ROOT / '.cache/mizuki-native-rules/client-cab-map.json'))
    bundle = 'battle/[pack]common.ab'
    sfiles = env.load_rel(bundle)
    selected = None
    for sf in sfiles:
        for obj in sf.objects.values():
            if obj.type.name != 'MonoBehaviour':
                continue
            tree = env.tt(obj)
            script_file, script = env.resolve(sf, tree.get('m_Script', {}))
            if not script or env.tt(script).get('m_ClassName') != 'CameraController':
                continue
            go_file, go = env.resolve(sf, tree['m_GameObject'])
            if env.tt(go).get('m_Name') == 'CameraController':
                selected = sf, obj, tree
    if selected is None:
        raise ValueError('Original CameraController prefab unavailable')
    sf, controller, controller_tree = selected
    camera_file, camera = env.resolve(sf, controller_tree['_camera'])
    camera_tree = env.tt(camera)
    go_file, go = env.resolve(camera_file, camera_tree['m_GameObject'])
    transform = None
    for component in env.tt(go)['m_Component']:
        component_file, obj = env.resolve(go_file, component['component'])
        if obj and obj.type.name == 'Transform':
            transform = component_file, obj, env.tt(obj)
            break
    if transform is None:
        raise ValueError('Original camera transform unavailable')
    OUT.mkdir(parents=True, exist_ok=True)
    evidence = []
    for source_file, obj, tree in [selected, (camera_file, camera, camera_tree), transform]:
        relative = 'raw/' + str(obj.path_id) + '.' + obj.type.name + '.bin'
        path = OUT / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        body = obj.get_raw_data()
        path.write_bytes(body)
        evidence.append({'serializedFile': source_file.name, 'pathId': str(obj.path_id), 'type': obj.type.name, 'file': relative, 'sha256': sha(body), 'bytes': len(body), 'native': tree})
    quat = [transform[2]['m_LocalRotation'][axis] for axis in 'xyzw']
    camera_rotation = compose([0, 0, 0], quat, [1, 1, 1])
    scenes = {}
    for scene_id, entry in manifest['scenes'].items():
        scene = read(MAPS / entry['file'])
        descriptors = [(root, read(MAPS / 'fx' / root['file'])) for root in scene['roots']]
        root, descriptor = next((root, descriptor) for root, descriptor in descriptors if any(any(b['class'] == 'MapGraphic' for b in node.get('behaviours', [])) for node in descriptor['nodes']))
        nodes = {node['id']: node for node in descriptor['nodes']}
        graphic = next(node for node in nodes.values() if any(b['class'] == 'MapGraphic' for b in node.get('behaviours', [])))
        settings = next(b['fields']['_mapSettings'] for b in graphic['behaviours'] if b['class'] == 'MapGraphic')
        store = next((b['fields'] for b in graphic['behaviours'] if b['class'] == 'StoreValueComponent'), {})
        focus = next((row['value'] for row in store.get('_objects', []) if row['key'] == 'camera_focus'), None)
        offset = next((row for row in store.get('_values', []) if row['key'] == 'camera_offset'), None)
        matrices = {}

        def world(node):
            if node['id'] not in matrices:
                local = compose(node['pos'], node['rot'], node['scale'])
                matrices[node['id']] = multiply(world(nodes[node['parent']]), local) if node['parent'] in nodes else local
            return matrices[node['id']]

        tile = next(node for node in nodes.values() if node['name'] == 'Tiles')
        row_count = int(max(node['pos'][1] + 1 for node in nodes.values() if any(b['class'] == 'Tile' for b in node.get('behaviours', []))))
        tiles_inverse = inverse(world(tile))
        board_basis = multiply([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, -1, 0], [0, 0, 0, 1]], tiles_inverse)
        top_down_basis = multiply([[1, 0, 0, 0], [0, -1, 0, row_count-1], [0, 0, -1, 0], [0, 0, 0, 1]], tiles_inverse)
        focus_node = nodes[focus['node']] if focus and 'node' in focus else None
        focus_position = point(world(focus_node), [0, 0, 0]) if focus_node else None
        camera_offset = [float(value) for value in offset['value'].split(',')] if offset else [0, 0, 0]
        position = [focus_position[i] + camera_offset[i] for i in range(3)] if focus_position else presets[settings['cameraView']]['position']
        scenes[scene_id] = {
            'source': {'rootKey': root['key'], 'rootFile': 'fx/' + root['file'], 'mapGraphicNode': graphic['id'], 'gameObject': graphic.get('sourceGameObject'), 'sourceBundlesSha256': scene['sourceBundlesSha256']},
            'cameraView': settings['cameraView'], 'cameraViewName': presets[settings['cameraView']]['name'],
            'storeValueCameraFocus': focus, 'storeValueCameraOffset': offset,
            'focusNode': focus_node['id'] if focus_node else None, 'focusWorldPosition': focus_position,
            'offsetInSourceWorldAxes': camera_offset, 'sourceWorldPosition': position,
            'positionSource': 'focus.position + cameraOffset' if focus_node else 'Consts.CAMERA_VIEWS[cameraView]',
            'sourceWorldFromTiles': world(tile), 'tilesFromSourceWorld': tiles_inverse,
            'boardFromSourceWorld': board_basis, 'boardPosition': point(board_basis, position),
            'topDownBoardFromSourceWorld': top_down_basis, 'topDownBoardPosition': point(top_down_basis, position),
            'rows': row_count,
        }
    result = {
        'version': 1, 'set': 'mizuki-native-cameras', 'source': 'local-client',
        'semantics': {'focus': 'Transform.position in source world coordinates; used as a position anchor, not a look-at target', 'offset': 'Added component-wise to focus.position without rotating or transforming it', 'rotation': 'Keep original camera rotation; Unity camera local forward +Z, up +Y', 'fallback': 'Use Consts.CAMERA_VIEWS[cameraView] only when no valid focus Transform exists', 'board': 'Native physical board is Tiles.x, Tiles.y, -Tiles.z. Apply boardFromSourceWorld to the position and its linear part to forward/up. Server top-down row mirroring belongs at the Mizuki input/output adapter; topDownBoardFromSourceWorld is supplied separately for that convention'},
        'camera': {'rotation': quat, 'sourceForward': point(camera_rotation, [0, 0, 1]), 'sourceUp': point(camera_rotation, [0, 1, 0]), 'verticalFov': camera_tree['field of view'], 'near': camera_tree['near clip plane'], 'far': camera_tree['far clip plane'], 'orthographic': camera_tree['orthographic'], 'cullingMask': camera_tree['m_CullingMask'], 'aspectAdaptation': {key: controller_tree[key] for key in ['_fromResolution', '_toResolution', '_fromLocalPosition', '_toLocalPosition']}},
        'prefabSource': {'bundle': bundle, 'bundleSha256': sha((CLIENT / bundle).read_bytes()), 'records': evidence},
        'presets': presets, 'presetSource': preset_source, 'stages': manifest['stages'], 'scenes': scenes,
    }
    body = (json.dumps(portable(result), ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf8')
    path = OUT / 'cameras.json'
    path.write_bytes(body)
    print(json.dumps({'ok': True, 'scenes': len(scenes), 'stages': len(result['stages']), 'presetPositions': presets, 'bytes': len(body), 'sha256': sha(body), 'output': str(path)}))


if __name__ == '__main__':
    run()
