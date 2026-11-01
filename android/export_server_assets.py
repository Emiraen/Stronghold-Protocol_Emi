import json, os, pathlib, sys, tarfile
stage = pathlib.Path('/opt/stronghold-release-staging/android-export-20261025')
root = pathlib.Path('/opt/Stronghold-Protocol/public')
plan = json.loads((stage / 'resource-plan.json').read_text())
missing = []
found = []
for url, entry in plan['missing']:
    rel = pathlib.PurePosixPath(url.lstrip('/'))
    if not str(rel).startswith(('assets/', 'fonts/')) or '..' in rel.parts:
        raise ValueError('Invalid public asset path')
    path = root / str(rel)
    if path.is_file() and not path.is_symlink():
        found.append((path, str(rel)))
    else:
        missing.append({'path': url, 'groups': entry['groups']})
with tarfile.open(stage / 'resources.tar', 'w') as output:
    for path, rel in found:
        output.add(path, arcname=rel, recursive=False)
report = {'exported': len(found), 'bytes': (stage / 'resources.tar').stat().st_size, 'missing': missing}
(stage / 'resource-export.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
os.chmod(stage / 'resources.tar', 0o600)
print(json.dumps({'exported': len(found), 'bytes': report['bytes'], 'missing': len(missing), 'samples': missing[:6]}, ensure_ascii=False))
