#!/usr/bin/env python3
"""Read-only, exhaustive integrity audit for the private Mizuki resource packages.

Only the JSON report under .cache is written.  --skip-maps is a preliminary
audit and deliberately never returns a complete/pass result.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys
import wave
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath


DEFAULT_CLIENT = Path("C:/Program Files/Hypergryph Launcher/games/Arknights Game/Arknights_Data/StreamingAssets/AB/Windows")
DEFAULT_BACKUP = Path("D:/Stronghold-Protocol_Backups/original-before-mizuki-manual-20261027-105004")
DEFAULT_EXPORT = Path("D:/Stronghold-Protocol_Emi-master.backup-before-annihilation-direct-20261025-003701/exports/is3-mizuki-20261027")
SHA256 = re.compile(r"^[0-9a-fA-F]{64}$")


def reject_constant(value):
    raise ValueError("non-finite JSON constant: " + value)


def finite_float(value):
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("non-finite JSON number: " + value)
    return number


class Audit:
    def __init__(self, args):
        self.root = args.root.resolve()
        self.client = args.client.resolve()
        self.backup = args.backup.resolve()
        self.export = args.source_export.resolve()
        self.issues = []
        self.warnings = []
        self.sections = {}
        self.counts = Counter()
        self.cache = {}
        self.json_cache = {}
        self.resolved_directories = {}
        self.directory_symlinks = {}
        self.progress = args.progress
        self.jobs = args.jobs
        self.section = "setup"
        self.levels = {}
        self.stages = {}

    def issue(self, code, file, detail):
        self.issues.append({"section": self.section, "code": code,
                            "file": str(file), "detail": str(detail)})

    def relative(self, base, value):
        if not isinstance(value, str) or not value:
            self.issue("invalid-path", base, repr(value))
            return None
        value = value.replace("\\", "/")
        path = PurePosixPath(value)
        if path.is_absolute() or ".." in path.parts or ":" in value:
            self.issue("unsafe-path", base, value)
            return None
        try:
            if base not in self.resolved_directories:
                self.resolved_directories[base] = base.resolve()
            resolved_base = self.resolved_directories[base]
            candidate = resolved_base / Path(*path.parts)
            parent = candidate.parent
            if parent not in self.resolved_directories:
                self.resolved_directories[parent] = parent.resolve()
            target = self.resolved_directories[parent] / candidate.name
            actual_parent = self.resolved_directories[parent]
            if actual_parent not in self.directory_symlinks:
                try:
                    with os.scandir(actual_parent) as entries:
                        self.directory_symlinks[actual_parent] = {entry.name for entry in entries if entry.is_symlink()}
                except OSError:
                    self.directory_symlinks[actual_parent] = None
            links = self.directory_symlinks[actual_parent]
            if (links is None and target.is_symlink()) or (links is not None and candidate.name in links):
                target = target.resolve()
        except OSError as exc:
            self.issue("unresolvable-path", base, str(value) + ": " + str(exc))
            return None
        if not target.is_relative_to(resolved_base):
            self.issue("escaped-path", target, value)
            return None
        return target

    def webpath(self, value):
        if not isinstance(value, str) or not value.startswith("/assets/mizuki/"):
            self.issue("non-private-asset-path", "public", repr(value))
            return None
        return self.relative(self.root / "public", value.lstrip("/"))

    def info(self, path):
        if path is None:
            return None
        if path in self.cache:
            return self.cache[path]
        try:
            digest = hashlib.sha256()
            total = 0
            with path.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    total += len(chunk)
                    digest.update(chunk)
            result = {"sha256": digest.hexdigest(), "bytes": total}
            self.counts["unique_files_hashed"] += 1
            self.counts["unique_bytes_hashed"] += total
        except OSError as exc:
            self.issue("unreadable-file", path, exc)
            result = None
        self.cache[path] = result
        return result

    def prehash(self, paths):
        """Read independent raw files concurrently; validate each expectation below."""
        paths = list(dict.fromkeys(path for path in paths if path is not None and path not in self.cache))
        def digest(path):
            try:
                sha = hashlib.sha256()
                total = 0
                with path.open("rb") as handle:
                    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                        total += len(chunk)
                        sha.update(chunk)
                return path, {"sha256": sha.hexdigest(), "bytes": total}, None
            except OSError as exc:
                return path, None, str(exc)
        with ThreadPoolExecutor(max_workers=self.jobs) as executor:
            for path, result, error in executor.map(digest, paths):
                self.cache[path] = result
                if error:
                    self.issue("unreadable-file", path, error)
                else:
                    self.counts["unique_files_hashed"] += 1
                    self.counts["unique_bytes_hashed"] += result["bytes"]

    def strict_json(self, path):
        if path is None:
            return None
        if path in self.json_cache:
            return self.json_cache[path]
        try:
            data = json.loads(path.read_text(encoding="utf-8-sig"),
                              parse_constant=reject_constant, parse_float=finite_float)
            self.counts["portable_json_files_checked"] += 1
        except (OSError, ValueError, UnicodeError) as exc:
            self.issue("invalid-portable-json", path, exc)
            data = None
        self.json_cache[path] = data
        return data

    def file(self, path, sha=None, size=None, *, mandatory_size=True, portable=True):
        self.counts["file_expectations"] += 1
        valid_sha = isinstance(sha, str) and SHA256.fullmatch(sha)
        if not valid_sha:
            self.issue("missing-or-invalid-sha256", path, repr(sha))
        valid_size = isinstance(size, int) and not isinstance(size, bool) and size >= 0
        if mandatory_size and not valid_size:
            self.issue("missing-or-invalid-bytes", path, repr(size))
        elif size is not None and not valid_size:
            self.issue("invalid-bytes", path, repr(size))
        actual = self.info(path)
        if actual:
            if valid_sha:
                self.counts["sha256_expectations_checked"] += 1
                if actual["sha256"] != sha.lower():
                    self.issue("sha256-mismatch", path,
                               "expected " + sha.lower() + "; actual " + actual["sha256"])
            if valid_size:
                self.counts["byte_expectations_checked"] += 1
                if actual["bytes"] != size:
                    self.issue("byte-count-mismatch", path,
                               "expected %s; actual %s" % (size, actual["bytes"]))
            if portable and path.suffix.lower() == ".json":
                self.strict_json(path)
        return actual

    def source_bundles(self, entries, label):
        if not isinstance(entries, dict) or not entries:
            self.issue("missing-source-bundles", label, "expected nonempty bundle SHA256 map")
            return
        for bundle, sha in entries.items():
            self.file(self.relative(self.client, bundle), sha,
                      mandatory_size=False, portable=False)
            self.counts["source_bundle_expectations"] += 1

    def begin(self, name):
        self.section = name
        self.sections[name] = {"errorsBefore": len(self.issues), "countsBefore": dict(self.counts)}

    def finish(self, **details):
        section = self.sections[self.section]
        section["errors"] = len(self.issues) - section.pop("errorsBefore")
        before = section.pop("countsBefore")
        section["checked"] = {key: value - before.get(key, 0)
                              for key, value in self.counts.items() if value != before.get(key, 0)}
        section["status"] = "failed" if section["errors"] else "passed"
        section.update(details)
        if self.progress:
            print("Checked %s: %s; errors=%s" % (self.section, section["status"], section["errors"]), flush=True)

    def messages(self, data, path):
        for field in ("missing", "errors"):
            value = data.get(field)
            if value:
                self.issue("manifest-" + field, path, repr(value))
        if data.get("warnings"):
            self.warnings.append({"section": self.section, "file": str(path),
                                  "warnings": data["warnings"]})

    def groups(self, relative_manifest):
        path = self.root / relative_manifest
        data = self.strict_json(path)
        seen = set()
        records = 0
        half_records = 0
        if not isinstance(data, dict):
            self.issue("invalid-manifest", path, "expected object")
            return {}, seen, records, half_records
        self.messages(data, path)
        groups = data.get("groups")
        if not isinstance(groups, dict) or not groups:
            self.issue("missing-groups", path, "expected nonempty groups")
            return data, seen, records, half_records
        for name, entries in groups.items():
            if not isinstance(entries, dict) or not entries:
                self.issue("invalid-group", path, name)
                continue
            for key, record in entries.items():
                records += 1
                if not isinstance(record, dict):
                    self.issue("invalid-asset-record", path, name + "/" + key)
                    continue
                target = self.webpath(record.get("path"))
                self.file(target, record.get("sha256"), record.get("bytes"))
                if target:
                    seen.add(target)
                if "half" in record:
                    half_records += 1
                    half = record["half"]
                    if isinstance(half, dict):
                        self.file(self.webpath(half.get("path")), half.get("sha256"), half.get("bytes"))
                    else:
                        self.file(self.webpath(half), record.get("halfSha256"), record.get("halfBytes"))
                elif "halfSha256" in record or "halfBytes" in record:
                    self.issue("missing-half-path", target, name + "/" + key)
        return data, seen, records, half_records

    def group_section(self, name, path):
        self.begin(name)
        data, seen, records, halves = self.groups(path)
        self.finish(groups=len(data.get("groups", {})), assets=records, halfAssets=halves,
                    declaredCount=data.get("count"))
        return data, seen

    def facilities(self):
        self.begin("native-facilities")
        wrapper_path = self.root / "public/assets/mizuki/native-facilities/manifest.json"
        data = self.strict_json(wrapper_path)
        fx, hashed, records, halves = self.groups("public/assets/mizuki/native-facilities/fx/manifest.json")
        if not isinstance(data, dict):
            self.issue("invalid-manifest", wrapper_path, "expected object")
            self.finish()
            return
        self.messages(data, wrapper_path)
        self.source_bundles(data.get("bundlesSha256"), wrapper_path)
        facilities = data.get("facilities", {})
        if not isinstance(facilities, dict) or len(facilities) != 14:
            self.issue("facility-count", wrapper_path, "expected 14 facilities")
        for field in ("fxIndex", "fxTextures"):
            target = self.webpath(data.get(field))
            if target not in hashed:
                self.issue("unhashed-facility-reference", wrapper_path, field)
        expected_fx = self.root / "public/assets/mizuki/native-facilities/fx/manifest.json"
        if self.webpath(data.get("fxManifest")) != expected_fx.resolve():
            self.issue("incorrect-fx-manifest-reference", wrapper_path, data.get("fxManifest"))
        def references(value, label):
            if isinstance(value, dict):
                if "path" in value:
                    target = self.webpath(value["path"])
                    if target not in hashed:
                        self.issue("unhashed-facility-reference", wrapper_path, label)
                for key, child in value.items():
                    references(child, label + "/" + str(key))
            elif isinstance(value, list):
                for index, child in enumerate(value):
                    references(child, label + "/" + str(index))
        references(facilities, "facilities")
        spines = data.get("spines", {})
        expected_spines = {"trap_024_npcsld", "trap_065_normbox", "trap_066_rarebox", "trap_068_badbox"}
        if not isinstance(spines, dict) or set(spines) != expected_spines:
            self.issue("facility-spine-set", wrapper_path, "expected four exact original Spine facilities")
            spines = spines if isinstance(spines, dict) else {}
        references(spines, "spines")
        for key, entry in spines.items():
            if not isinstance(entry, dict):
                self.issue("invalid-facility-spine", wrapper_path, key)
                continue
            facility = facilities.get(key, {})
            if facility.get("spineKey") != key or facility.get("graphicPolicy") != "original-spine":
                self.issue("facility-spine-binding", wrapper_path, key)
            paths = [entry.get("skel"), entry.get("atlas"), *entry.get("textures", [])]
            named = entry.get("files", [])
            if not isinstance(named, list):
                self.issue("invalid-spine-file-list", wrapper_path, key)
                named = []
            files = {item.get("name"): item for item in named if isinstance(item, dict)}
            if len(files) != len(paths) or len(named) != len(paths):
                self.issue("incomplete-spine-file-list", wrapper_path, key)
            for url in paths:
                target = self.webpath(url)
                if target not in hashed:
                    self.issue("unhashed-spine-model-file", wrapper_path, key + ": " + str(url))
                record = files.get(PurePosixPath(url).name, {}) if isinstance(url, str) else {}
                self.file(target, record.get("sha256"), record.get("bytes"), portable=False)
            if not entry.get("sourceObjects"):
                self.issue("missing-spine-source-objects", wrapper_path, key)
        self.finish(facilities=len(facilities) if isinstance(facilities, dict) else 0,
                    assets=records, halfAssets=halves, spines=len(spines),
                    sourceBundles=len(data.get("bundlesSha256", {})))

    def route_sprites(self):
        self.begin("route-sprites")
        path = self.root / "public/assets/mizuki/native-ui-motion/route-sprites/manifest.json"
        data = self.strict_json(path)
        if not isinstance(data, dict):
            self.issue("invalid-manifest", path, "expected object")
            self.finish()
            return
        sprites = data.get("sprites", {})
        if not isinstance(sprites, dict) or len(sprites) < 3:
            self.issue("route-sprite-count", path, "expected at least 3 original sprites")
            sprites = sprites if isinstance(sprites, dict) else {}
        for key, record in sprites.items():
            if not isinstance(record, dict):
                self.issue("invalid-sprite", path, key)
                continue
            self.file(self.webpath(record.get("path")), record.get("sha256"), record.get("bytes"))
        self.source_bundles({data.get("sourceBundle"): data.get("sourceSha256")}, path)
        self.finish(sprites=len(sprites))

    def motion(self):
        self.begin("native-ui-motion")
        package = self.root / "public/assets/mizuki/native-ui-motion"
        path = package / "manifest.json"
        data = self.strict_json(path)
        if not isinstance(data, dict):
            self.issue("invalid-manifest", path, "expected object")
            self.finish()
            return
        self.messages(data, path)
        try:
            declared_source = Path(data.get("source", "")).resolve()
        except (TypeError, OSError) as exc:
            self.issue("invalid-motion-source", path, exc)
            declared_source = None
        if declared_source != self.export:
            self.issue("unexpected-motion-source", path, repr(data.get("source")))
        objects = data.get("objects", {})
        if not isinstance(objects, dict) or len(objects) < 142:
            self.issue("motion-object-count", path, "expected at least 142 original objects")
            objects = objects if isinstance(objects, dict) else {}
        for key, record in objects.items():
            if not isinstance(record, dict):
                self.issue("invalid-motion-object", path, key)
                continue
            self.file(self.relative(package, record.get("file")), record.get("sha256"),
                      record.get("bytes"), mandatory_size=False)
            self.file(self.relative(package, record.get("raw")), record.get("sourceSha256"),
                      record.get("sourceBytes"), mandatory_size=False, portable=False)
            self.file(self.relative(self.export, record.get("source")), record.get("sourceSha256"),
                      record.get("sourceBytes"), mandatory_size=False, portable=False)
        nodes = data.get("nodeViewData", [])
        if not isinstance(nodes, list) or not nodes:
            self.issue("missing-node-view-data", path, "expected nonempty list")
            nodes = nodes if isinstance(nodes, list) else []
        for index, record in enumerate(nodes):
            if not isinstance(record, dict):
                self.issue("invalid-node-view-data", path, index)
                continue
            self.file(self.relative(package, record.get("file")), record.get("sha256"),
                      record.get("bytes"), mandatory_size=False)
        self.finish(objects=len(objects), portableObjects=len(objects),
                    preservedOriginals=len(objects), sourceOriginals=len(objects), nodeViewFiles=len(nodes))

    def levels_check(self):
        self.begin("original-levels")
        package = self.root / "data/mizuki/levels"
        path = package / "index.json"
        data = self.strict_json(path)
        if not isinstance(data, dict):
            self.issue("invalid-level-index", path, "expected object")
            self.finish()
            return
        self.messages(data, path)
        levels = data.get("levelsById", {})
        stages = data.get("stagesById", {})
        if not isinstance(levels, dict):
            self.issue("invalid-levels", path, "expected object")
            levels = {}
        if not isinstance(stages, dict):
            self.issue("invalid-stage-aliases", path, "expected object")
            stages = {}
        if len(levels) != 60:
            self.issue("original-level-count", path, "expected 60; actual " + str(len(levels)))
        files = set()
        for level_id, record in levels.items():
            if not isinstance(record, dict):
                self.issue("invalid-level-record", path, level_id)
                continue
            target = self.relative(package, record.get("file"))
            self.file(target, record.get("sha256"), record.get("bytes"))
            files.add(target)
        if len(files) != len(levels):
            self.issue("duplicate-level-files", path, "canonical levels must each have a distinct file")
        for stage, record in stages.items():
            if not isinstance(record, dict):
                self.issue("invalid-stage-alias", path, stage)
                continue
            canonical = levels.get(record.get("levelId"))
            if not isinstance(canonical, dict):
                self.issue("unknown-stage-level", path, stage)
                continue
            for field in ("file", "sha256", "bytes", "url"):
                if record.get(field) != canonical.get(field):
                    self.issue("stage-alias-mismatch", path, stage + ": " + field)
        self.levels, self.stages = levels, stages
        self.finish(canonicalLevels=len(levels), stageAliases=len(stages))

    def isolation(self):
        self.begin("shared-file-isolation")
        path = self.root / ".cache/mizuki-preview/isolation-verification-20261027.json"
        inventory = self.strict_json(path)
        if not isinstance(inventory, list):
            self.issue("invalid-isolation-inventory", path, "expected list")
            self.finish()
            return
        if len(inventory) != 41:
            self.issue("isolation-file-count", path, "expected 41; actual " + str(len(inventory)))
        files = set()
        for record in inventory:
            if not isinstance(record, dict):
                self.issue("invalid-isolation-record", path, repr(record))
                continue
            name = record.get("file")
            current = self.relative(self.root, name)
            baseline = self.relative(self.backup, name)
            expected = record.get("baselineSha256")
            actual = self.file(current, expected, mandatory_size=False, portable=False)
            original = self.file(baseline, expected, mandatory_size=False, portable=False)
            if actual and original and actual != original:
                self.issue("shared-file-differs-from-backup", current, str(baseline))
            if name in files:
                self.issue("duplicate-isolation-file", path, name)
            files.add(name)
        self.finish(files=len(files), backup=str(self.backup))

    def maps(self, skip=False, skip_raw=False):
        self.begin("native-maps")
        if skip:
            self.finish(expectedScenes=60)
            self.sections[self.section]["status"] = "deferred"
            self.sections[self.section]["reason"] = "--skip-maps requested; full export not audited"
            return
        package = self.root / "public/assets/mizuki/native-maps"
        path = package / "manifest.json"
        data, hashed, records, halves = self.groups("public/assets/mizuki/native-maps/manifest.json")
        scenes = data.get("scenes", {})
        if not isinstance(scenes, dict):
            self.issue("invalid-scenes", path, "expected object")
            scenes = {}
        expected = {PurePosixPath(key).name for key in self.levels}
        if len(scenes) != 60:
            self.issue("native-map-count", path, "expected 60; actual " + str(len(scenes)))
        missing = sorted(expected - set(scenes))
        extra = sorted(set(scenes) - expected)
        if missing:
            self.issue("missing-native-scenes", path, missing)
        if extra:
            self.issue("unexpected-native-scenes", path, extra)
        raw_total = 0
        all_bundles = {}
        for scene_index, (name, record) in enumerate(scenes.items()):
            if not isinstance(record, dict):
                self.issue("invalid-scene-record", path, name)
                continue
            target = self.relative(package, record.get("file"))
            self.file(target, record.get("sha256"), record.get("bytes"))
            scene = self.strict_json(target)
            bundles = record.get("sourceBundlesSha256")
            self.source_bundles(bundles, name)
            if isinstance(bundles, dict):
                expected_main = "scenes/obt/roguelike/ro2/%s/%s.ab" % (name, name)
                expected_light = "scenes/obt/roguelike/ro2/%s/%s/lightingdata.ab" % (name, name)
                if set(bundles) != {expected_main, expected_light}:
                    self.issue("scene-source-bundle-set", name,
                               "expected main + lightingdata bundle; actual " + repr(sorted(bundles)))
                for bundle, sha in bundles.items():
                    if bundle in all_bundles and all_bundles[bundle] != sha:
                        self.issue("conflicting-bundle-sha256", name, bundle)
                    all_bundles[bundle] = sha
            if not isinstance(scene, dict):
                self.issue("invalid-scene-json", target, "expected object")
                continue
            self.messages(scene, target)
            if scene.get("name") != name:
                self.issue("scene-name-mismatch", target, repr(scene.get("name")))
            if scene.get("sourceBundlesSha256") != bundles:
                self.issue("scene-source-hashes-differ", target, "scene and manifest source maps differ")
            raw = scene.get("raw")
            if not isinstance(raw, list) or not raw:
                self.issue("missing-scene-raw-data", target, "expected nonempty raw list")
                raw = []
            if record.get("rawObjects") != len(raw):
                self.issue("scene-raw-count-mismatch", target,
                           "manifest %s; scene %s" % (record.get("rawObjects"), len(raw)))
            roots = scene.get("roots")
            if isinstance(roots, list) and record.get("roots") != len(roots):
                self.issue("scene-root-count-mismatch", target,
                           "manifest %s; scene %s" % (record.get("roots"), len(roots)))
            raw_total += len(raw)
            if skip_raw:
                continue
            raw_paths = set()
            prepared = [(index, raw_record, self.relative(package, raw_record.get("file")))
                        for index, raw_record in enumerate(raw) if isinstance(raw_record, dict)]
            self.prehash(item[2] for item in prepared)
            prepared_paths = {index: raw_path for index, _, raw_path in prepared}
            for index, raw_record in enumerate(raw):
                if not isinstance(raw_record, dict):
                    self.issue("invalid-raw-object", target, index)
                    continue
                raw_path = prepared_paths[index]
                self.file(raw_path, raw_record.get("sha256"), raw_record.get("bytes"), portable=False)
                if raw_path in raw_paths:
                    self.issue("duplicate-scene-raw-path", target, str(raw_path))
                raw_paths.add(raw_path)
            if self.progress and (scene_index + 1) % 10 == 0:
                print("Checked native scenes: %s/%s; raw objects=%s" % (scene_index + 1, len(scenes), raw_total), flush=True)
        mappings = data.get("stages", {})
        if not isinstance(mappings, dict):
            self.issue("invalid-map-stage-aliases", path, "expected object")
            mappings = {}
        for stage, entry in self.stages.items():
            wanted = PurePosixPath(entry.get("levelId", "")).name
            if mappings.get(stage) != wanted:
                self.issue("missing-or-wrong-map-stage", path,
                           stage + ": expected " + wanted + "; actual " + repr(mappings.get(stage)))
        for stage, name in mappings.items():
            if stage not in self.stages or name not in scenes:
                self.issue("unknown-map-stage", path, stage + ": " + str(name))
        if len(scenes) == 60 and len(all_bundles) != 120:
            self.issue("native-map-source-bundle-count", path,
                       "expected 120; actual " + str(len(all_bundles)))
        self.finish(scenes=len(scenes), expectedScenes=60, stageAliases=len(mappings),
                    assets=records, halfAssets=halves, rawObjects=raw_total,
                    rawObjectsRehashed=0 if skip_raw else raw_total,
                    sourceBundles=len(all_bundles))

    def map_quality(self):
        self.begin("native-map-lossless-additions")
        package = self.root / "public/assets/mizuki/native-maps"
        path = package / "manifest.json"
        data = self.strict_json(path) or {}
        groups = data.get("groups", {})
        original = groups.get("scene/textures", {})
        full = groups.get("scene/texture-fullres", {})
        lightmaps = groups.get("scene/lightmap-textures", {})
        payloads = groups.get("scene/texture-payloads", {})
        source_records = groups.get("scene/texture-sources", {})
        for name, entries, wanted in (("original", original, 204), ("fullres", full, 204),
                                      ("lightmap", lightmaps, 122), ("payload", payloads, 204),
                                      ("nonlightmap-source", source_records, 82)):
            if len(entries) != wanted:
                self.issue("native-texture-coverage", path, "%s expected %s; actual %s" % (name, wanted, len(entries)))
        if set(full) != set(original) or set(payloads) != set(original):
            self.issue("incomplete-full-texture-keyset", path, "fullres and payload must cover every original texture")
        if set(source_records) != set(full) - set(lightmaps):
            self.issue("incomplete-nonlightmap-source-keyset", path, "all 82 non-lightmap Texture2D records required")
        metadata = self.strict_json(package / "fx/textures.json") or {}
        textures = metadata.get("textures", {})
        lightmap_sources = {}
        for scene_id, scene_record in data.get("scenes", {}).items():
            scene = self.strict_json(self.relative(package, scene_record.get("file"))) or {}
            raw_index = {record.get("file"): record for record in scene.get("raw", []) if isinstance(record, dict)}
            for lightmap in scene.get("lightmaps", []):
                for field, reference in lightmap.get("textures", {}).items():
                    key = reference.get("textureKey")
                    pointer = reference.get("pptr", {})
                    if not key:
                        if str(pointer.get("m_PathID", "0")) != "0":
                            self.issue("unresolved-native-lightmap-pptr", path, scene_id + ": " + field)
                        continue
                    identity = reference.get("resolved", {})
                    original = raw_index.get(identity.get("rawFile"), {})
                    if not identity.get("serializedFile") or str(identity.get("pathId")) != str(pointer.get("m_PathID")) or identity.get("rawSha256") != original.get("sha256"):
                        self.issue("native-lightmap-source-identity-mismatch", path, scene_id + ": " + key)
                    if reference.get("fullres", {}).get("sha256") != full.get(key, {}).get("sha256") or reference.get("originalPayload", {}).get("sha256") != payloads.get(key, {}).get("sha256"):
                        self.issue("native-lightmap-resource-reference-mismatch", path, scene_id + ": " + key)
                    lightmap_sources[key] = identity
        if set(lightmap_sources) != set(lightmaps):
            self.issue("native-lightmap-source-identity-coverage", path, "every lightmap/shadowmask must retain its actual scene PPtr resolution")
        checked_pixels = 0
        from PIL import Image
        for key, record in full.items():
            target = self.webpath(record.get("path"))
            item = textures.get(key, {})
            if key not in lightmap_sources and (not item.get("sourceTextureSerializedFile") or not item.get("sourceTexturePathId")):
                self.issue("missing-original-texture-identity", target, key)
            if not item.get("losslessFile") or not str(record.get("path")).endswith("/" + item.get("losslessFile", "")):
                self.issue("wrong-lossless-texture-reference", target, key)
            if item.get("losslessSha256") != record.get("sha256") or item.get("losslessBytes") != record.get("bytes"):
                self.issue("lossless-texture-metadata-mismatch", target, key)
            if item.get("nativeTexturePayloadSha256") != payloads.get(key, {}).get("sha256"):
                self.issue("native-texture-payload-reference-mismatch", target, key)
            try:
                with Image.open(target) as image:
                    if image.format != "PNG" or image.size != (record.get("w"), record.get("h")):
                        self.issue("not-native-resolution-png", target, str(image.size))
                    digest = hashlib.sha256(image.tobytes()).hexdigest()
                if record.get("decodedPixelSha256") != digest or record.get("nativePixelFingerprintVerified") is not True:
                    self.issue("native-pixel-fingerprint-mismatch", target, key)
                checked_pixels += 1
            except (OSError, ValueError) as exc:
                self.issue("unreadable-full-texture", target, exc)
        self.finish(fullResolutionTextures=len(full), lightmapTextures=len(lightmaps),
                    nonLightmapSources=len(source_records), sourceIdentities=len(lightmap_sources) + len(source_records),
                    lightmapSourceIdentities=len(lightmap_sources), decodedPixelFingerprints=checked_pixels)

    def gates(self):
        self.begin("native-gates")
        package = self.root / "public/assets/mizuki/native-gates"
        path = package / "manifest.json"
        data, hashed, records, halves = self.groups("public/assets/mizuki/native-gates/manifest.json")
        self.source_bundles(data.get("sourceBundlesSha256"), path)
        expected = {"tile_start", "tile_end", "tile_flystart", "tile_end_special"}
        if set(data.get("prefabs", {})) != expected:
            self.issue("native-gate-prefab-set", path, "expected four original gate prefabs")
        raw = data.get("raw", [])
        if not isinstance(raw, list) or not raw:
            self.issue("missing-gate-originals", path, "expected all original serialized objects")
            raw = []
        prepared = [(entry, self.relative(package, entry.get("file"))) for entry in raw if isinstance(entry, dict)]
        self.prehash(item[1] for item in prepared)
        for entry, target in prepared:
            self.file(target, entry.get("sha256"), entry.get("bytes"), portable=False)
        placements = data.get("groups", {}).get("gates", {})
        usage = Counter()
        total = 0
        map_manifest = self.strict_json(self.root / "public/assets/mizuki/native-maps/manifest.json") or {}
        source_levels = {PurePosixPath(key).name: value for key, value in self.levels.items()}
        scene_count = 0
        for _, record in placements.items():
            doc = self.strict_json(self.webpath(record.get("path"))) or {}
            if doc.get("stages") != map_manifest.get("stages"):
                self.issue("gate-stage-map-mismatch", path, "must cover exact original 97 stage aliases")
            scene_count += len(doc.get("scenes", {}))
            for scene_id, scene in doc.get("scenes", {}).items():
                metadata = source_levels.get(scene_id, {})
                level = self.strict_json(self.relative(self.root / "data/mizuki/levels", metadata.get("file"))) or {}
                level_map = level.get("mapData", {})
                for gate in scene.get("gates", []):
                    total += 1
                    effect = gate.get("effect")
                    usage[effect] += 1
                    if effect not in expected or not gate.get("ancestry"):
                        self.issue("invalid-original-gate-placement", path, scene_id + ": " + str(gate.get("name")))
                    root = map_manifest.get("groups", {}).get("scene/roots", {}).get(gate.get("rootKey"), {})
                    prefab = self.strict_json(self.webpath(root.get("path"))) or {}
                    nodes = prefab.get("nodes", [])
                    node = next((item for item in nodes if item.get("id") == gate.get("node")), None)
                    if not node or node.get("name") != gate.get("name"):
                        self.issue("gate-native-node-mismatch", path, scene_id + ": " + str(gate.get("node")))
                    try:
                        tile_index = level_map["map"][gate["gridRow"]][gate["gridCol"]]
                        if tile_index != gate["levelTileIndex"] or level_map["tiles"][tile_index]["tileKey"] != gate["tileKey"]:
                            self.issue("gate-original-level-coordinate-mismatch", path, scene_id + ": " + str(gate.get("name")))
                    except (KeyError, IndexError, TypeError) as exc:
                        self.issue("invalid-gate-level-coordinate", path, scene_id + ": " + str(exc))
        if scene_count != 60 or total != 280 or dict(usage) != data.get("usage"):
            self.issue("gate-placement-coverage", path, "scenes=%s; placements=%s; usage=%s" % (scene_count, total, dict(usage)))
        self.finish(assets=records, halfAssets=halves, rawObjects=len(raw), scenes=scene_count,
                    placements=total, sourceBundles=len(data.get("sourceBundlesSha256", {})))

    def audio(self):
        self.begin("native-audio")
        path = self.root / "public/assets/mizuki/native-audio/manifest.json"
        data, hashed, records, halves = self.groups("public/assets/mizuki/native-audio/manifest.json")
        self.source_bundles(data.get("bundlesSha256"), path)
        tracks = data.get("tracks", {})
        stages = data.get("stages", {})
        levels = data.get("levels", {})
        events = data.get("events", {})
        for name, value, expected in (("tracks", tracks, 13), ("stages", stages, 97),
                                      ("levels", levels, 60), ("events", events, 7)):
            if not isinstance(value, dict) or len(value) != expected:
                self.issue("audio-" + name + "-count", path, "expected " + str(expected))
        if not all(isinstance(value, dict) for value in (tracks, stages, levels, events)):
            self.finish(assets=records)
            return
        source = data.get("audioDataSource", {})
        source_path = self.root / ".cache/mizuki-native-audio/audio_data.json"
        self.file(source_path, source.get("sha256"), source.get("bytes"))
        source_table = self.strict_json(source_path) or {}
        banks = source_table.get("bgmBanks", [])
        for event, entry in events.items():
            try:
                evidence = entry["evidence"]
                index = int(evidence["jsonPointer"].split("/")[-1])
                original = banks[index]
                if evidence["record"] != original or entry["bank"] != original["name"]:
                    self.issue("audio-bank-evidence-mismatch", path, event)
                if tracks.get(entry["loop"], {}).get("asset") != original["loop"]:
                    self.issue("audio-loop-evidence-mismatch", path, event)
                actual_intro = tracks.get(entry.get("intro"), {}).get("asset") if entry.get("intro") else None
                if actual_intro != original.get("intro"):
                    self.issue("audio-intro-evidence-mismatch", path, event)
            except (KeyError, IndexError, TypeError, ValueError) as exc:
                self.issue("invalid-audio-bank-evidence", path, event + ": " + str(exc))
        index_path = self.root / "data/mizuki/levels/index.json"
        index_record = data.get("levelIndex", {})
        self.file(index_path, index_record.get("sha256"), index_record.get("bytes"))
        level_index = self.strict_json(index_path) or {}
        for level_id, metadata in level_index.get("levelsById", {}).items():
            level_path = self.relative(self.root / "data/mizuki/levels", metadata.get("file"))
            self.file(level_path, metadata.get("sha256"), metadata.get("bytes"))
            level = self.strict_json(level_path) or {}
            if levels.get(level_id, {}).get("bgmEvent") != level.get("bgmEvent"):
                self.issue("audio-original-level-event-mismatch", path, level_id)
        for stage_id, metadata in level_index.get("stagesById", {}).items():
            entry = stages.get(stage_id, {})
            canonical = levels.get(metadata["levelId"], {})
            if entry != canonical or entry.get("levelId") != metadata["levelId"]:
                self.issue("audio-stage-alias-mismatch", path, stage_id)
        for url, track in tracks.items():
            target = self.webpath(track.get("path"))
            self.file(target, track.get("sha256"), track.get("bytes"), portable=False)
            if target not in hashed or url != track.get("path"):
                self.issue("unhashed-audio-track", path, url)
            for field in ("original", "rawObject", "typeTree"):
                record = track.get(field, {})
                file = self.webpath(record.get("path"))
                self.file(file, record.get("sha256"), record.get("bytes"))
                if file not in hashed:
                    self.issue("unhashed-audio-original", path, url + ": " + field)
            try:
                with wave.open(str(target), "rb") as pcm:
                    actual = {"channels": pcm.getnchannels(), "sampleRate": pcm.getframerate(),
                              "bitsPerSample": pcm.getsampwidth() * 8, "frames": pcm.getnframes()}
                for key, value in actual.items():
                    if track.get(key) != value:
                        self.issue("audio-pcm-format-mismatch", target, key)
                original = self.strict_json(self.webpath(track["typeTree"]["path"])) or {}
                for key, source_key in (("channels", "m_Channels"), ("sampleRate", "m_Frequency"),
                                        ("bitsPerSample", "m_BitsPerSample")):
                    if actual[key] != original.get(source_key):
                        self.issue("audio-quality-changed", target, key)
            except (OSError, wave.Error, KeyError, TypeError) as exc:
                self.issue("invalid-native-pcm-audio", target, exc)
            if track.get("sourceBundleSha256") != data.get("bundlesSha256", {}).get(track.get("sourceBundle")):
                self.issue("audio-source-bundle-mismatch", target, track.get("sourceBundle"))
        self.finish(assets=records, tracks=len(tracks), stageAliases=len(stages),
                    canonicalLevels=len(levels), events=len(events), sourceBundles=len(data.get("bundlesSha256", {})))

    def reflections(self):
        self.begin("native-reflections")
        package = self.root / "public/assets/mizuki/native-reflections"
        path = package / "manifest.json"
        data, hashed, records, halves = self.groups("public/assets/mizuki/native-reflections/manifest.json")
        self.source_bundles(data.get("bundlesSha256"), path)
        scenes = data.get("scenes", {})
        cubes = data.get("cubemaps", {})
        atlases = data.get("atlases", {})
        native_maps = self.strict_json(self.root / "public/assets/mizuki/native-maps/manifest.json") or {}
        if data.get("complete") is not True or len(scenes) != 60 or set(scenes) != set(native_maps.get("scenes", {})):
            self.issue("incomplete-native-reflection-scenes", path, "expected complete exact 60 scene set")
        if data.get("stages") != native_maps.get("stages"):
            self.issue("reflection-stage-aliases-mismatch", path, "expected exact 97 native map aliases")
        if len(cubes) != 119 or len(atlases) != 119:
            self.issue("reflection-cubemap-coverage", path, "expected 119 source Cubemaps and 119 intensity atlases")
        from PIL import Image
        total_mip_cells = 0
        for key, cube in cubes.items():
            payload = cube.get("payload", {})
            size, mips = cube.get("size", 0), cube.get("mips", 0)
            cells = cube.get("cells", [])
            if cube.get("faces") != 6 or cube.get("mipsStripped") != 0 or len(cells) != 6 * mips:
                self.issue("incomplete-cubemap-mips", path, key)
            offset = 0
            for face in range(6):
                y = 0
                for mip in range(mips):
                    cell = cells[face * mips + mip] if face * mips + mip < len(cells) else {}
                    side = max(1, size >> mip)
                    if (cell.get("face"), cell.get("mip"), cell.get("size"), cell.get("offset"), cell.get("x"), cell.get("y")) != (face, mip, side, offset, face * side, y):
                        self.issue("cubemap-mip-layout-mismatch", path, key + ": %s/%s" % (face, mip))
                    offset += cell.get("bytes", 0)
                    y += side
            if offset != payload.get("bytes"):
                self.issue("cubemap-payload-coverage-mismatch", path, key)
            total_mip_cells += len(cells)
            for field in ("payload", "rawObject", "typeTree", "sourceAtlas"):
                record = cube.get(field, {})
                target = self.webpath(record.get("path"))
                self.file(target, record.get("sha256"), record.get("bytes"))
                if target not in hashed:
                    self.issue("unhashed-cubemap-source", path, key + ": " + field)
            try:
                with Image.open(self.webpath(cube["sourceAtlas"]["path"])) as image:
                    if image.format != "PNG" or image.mode != "RGBA" or image.size != (6 * size, sum(max(1, size >> mip) for mip in range(mips))):
                        self.issue("cubemap-source-atlas-not-lossless-full-chain", path, key)
            except (OSError, KeyError, ValueError) as exc:
                self.issue("invalid-cubemap-source-atlas", path, key + ": " + str(exc))
        probes = 0
        defaults_selected = 0
        for name, scene in scenes.items():
            target = self.relative(package, scene.get("file"))
            self.file(target, scene.get("sha256"), scene.get("bytes"))
            doc = self.strict_json(target) or {}
            if doc.get("sourceBundlesSha256") != native_maps.get("scenes", {}).get(name, {}).get("sourceBundlesSha256"):
                self.issue("reflection-native-source-hash-mismatch", target, name)
            environment = doc.get("env") or {}
            atlas = atlases.get(environment.get("atlasKey"), {})
            cube = cubes.get(environment.get("cubemapKey"), {})
            if doc.get("images", {}).get("env") != atlas.get("path") or not atlas:
                self.issue("missing-consumable-reflection-env", target, name)
            if environment.get("size") != cube.get("size") or environment.get("mips") != cube.get("mips") or environment.get("range") != atlas.get("range"):
                self.issue("reflection-env-metadata-mismatch", target, name)
            if environment.get("intensityAlreadyApplied") is not True:
                self.issue("reflection-intensity-contract-missing", target, name)
            reflections = doc.get("reflections", {})
            source_probes = reflections.get("probes", [])
            probes += len(source_probes)
            all_records = list(source_probes)
            default = reflections.get("default")
            if default:
                all_records.append(default)
            if environment.get("source") == "default":
                defaults_selected += 1
                if source_probes:
                    self.issue("unexpected-reflection-default-selection", target, name)
            for reflection in all_records:
                cube = cubes.get(reflection.get("cubemapKey"), {})
                if str(reflection.get("pointer", {}).get("m_PathID")) != cube.get("pathId"):
                    self.issue("reflection-original-pptr-mismatch", target, name)
                tree = reflection.get("tree", {}) if reflection.get("source") == "probe" else doc.get("renderSettings", {}).get("tree", {})
                field = "m_IntensityMultiplier" if reflection.get("source") == "probe" else "m_ReflectionIntensity"
                if reflection.get("intensity") != tree.get(field):
                    self.issue("reflection-original-intensity-mismatch", target, name)
            light = doc.get("light", {})
            light_tree = light.get("tree", {})
            if light.get("intensity") != light_tree.get("m_Intensity") or light.get("color") != [light_tree.get("m_Color", {}).get(axis) for axis in "rgb"]:
                self.issue("original-main-light-values-mismatch", target, name)
            try:
                direction = light["dir"]
                matrix = doc["coordinateBasis"]["tiles"]["worldMatrix"]
                tiles_direction = [direction[0], -direction[1], -direction[2]]
                world = [sum(matrix[row][col] * tiles_direction[col] for col in range(3)) for row in range(3)]
                length = math.sqrt(sum(value * value for value in world))
                source = light["towardLightWorld"]
                source_length = math.sqrt(sum(value * value for value in source))
                if abs(sum(value * value for value in direction) - 1) > 1e-10 or any(abs(world[index] / length - source[index] / source_length) > 1e-10 for index in range(3)):
                    self.issue("main-light-tiles-board-direction-mismatch", target, name)
            except (KeyError, IndexError, TypeError, ZeroDivisionError) as exc:
                self.issue("invalid-main-light-transform", target, str(exc))
        if probes != 59 or defaults_selected != 1:
            self.issue("reflection-probe-coverage", path, "expected 59 native probes and one default-only scene")
        self.finish(assets=records, halfAssets=halves, scenes=len(scenes), stageAliases=len(data.get("stages", {})),
                    cubemaps=len(cubes), envAtlases=len(atlases), nativeProbes=probes,
                    completeFaceMipCells=total_mip_cells, defaultOnlyScenes=defaults_selected,
                    sourceBundles=len(data.get("bundlesSha256", {})))

    def run(self, skip_maps=False, only_audio=False, only_graphics=False):
        if only_graphics:
            self.levels_check()
            self.isolation()
            self.maps(skip_raw=True)
            self.map_quality()
            self.gates()
            self.reflections()
        elif not only_audio:
            self.group_section("private-battle-fx", "public/assets/mizuki/fx/manifest.json")
            self.group_section("native-ui-fx", "public/assets/mizuki/native-ui-motion/fx/manifest.json")
            self.group_section("native-board", "public/assets/mizuki/native-board/manifest.json")
            self.facilities()
            self.route_sprites()
            self.motion()
            self.levels_check()
            self.isolation()
            self.maps(skip_maps)
            if not skip_maps:
                self.map_quality()
            self.gates()
            self.reflections()
        if not only_graphics:
            self.audio()
        deferred = [name for name, section in self.sections.items() if section["status"] == "deferred"]
        status = "failed" if self.issues else ("incomplete" if deferred else "passed")
        return {"version": 1, "generatedAt": datetime.now(timezone.utc).isoformat(),
                "status": status, "complete": not self.issues and not deferred,
                "auditScope": "graphics-incremental" if only_graphics else ("audio-only" if only_audio else "full-private-resources"),
                "scope": ("Graphics incremental verification: all current map groups, lossless textures, gates and reflections; 74164 previously audited map raw objects are explicitly not rehashed." if only_graphics else
                          "Audio-only incremental verification; previously audited map raw files are not rehashed." if only_audio else
                          "Every recorded private resource, original raw object, source bundle, canonical level and shared isolation file; this does not certify gameplay completeness."),
                "root": str(self.root), "client": str(self.client), "sourceExport": str(self.export),
                "counts": dict(self.counts), "sections": self.sections,
                "deferred": deferred, "errors": self.issues, "warnings": self.warnings}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--client", type=Path, default=DEFAULT_CLIENT)
    parser.add_argument("--backup", type=Path, default=DEFAULT_BACKUP)
    parser.add_argument("--source-export", type=Path, default=DEFAULT_EXPORT)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--skip-maps", action="store_true",
                        help="preliminary audit only; report incomplete and exit 2 unless other checks fail")
    parser.add_argument("--progress", action="store_true", help="print compact section and ten-scene progress")
    parser.add_argument("--only-audio", action="store_true",
                        help="incremental audio audit only; never claim to have reverified all map resources")
    parser.add_argument("--only-graphics", action="store_true",
                        help="incremental maps/gates/reflections audit; explicitly skip already audited native-map raw files")
    parser.add_argument("--jobs", type=int, default=8, choices=range(1, 33), metavar="1..32",
                        help="parallel raw-object readers (default 8); no expectations are skipped")
    args = parser.parse_args()
    if args.only_audio and args.only_graphics or args.only_graphics and args.skip_maps:
        parser.error("Choose only one incremental scope; graphics scope requires maps")
    if args.report is None:
        basename = "graphics-resource-verification" if args.only_graphics else ("audio-resource-verification" if args.only_audio else "resource-verification")
        args.report = Path(".cache/mizuki-preview/" + basename + "-20261027.json")
    audit = Audit(args)
    report_path = args.report if args.report.is_absolute() else audit.root / args.report
    report_path = report_path.resolve()
    if not report_path.is_relative_to(audit.root / ".cache"):
        parser.error("--report must be inside the target project's .cache directory")
    report = audit.run(args.skip_maps, args.only_audio, args.only_graphics)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print("Mizuki resource audit: %s; errors=%d; deferred=%d; hashedFiles=%d; checkedSHA=%d; checkedBytes=%d; strictJSON=%d" % (
        report["status"].upper(), len(report["errors"]), len(report["deferred"]),
        audit.counts["unique_files_hashed"], audit.counts["sha256_expectations_checked"],
        audit.counts["byte_expectations_checked"], audit.counts["portable_json_files_checked"]))
    for name, section in report["sections"].items():
        metrics = "; ".join("%s=%s" % (key, section[key]) for key in (
            "assets", "halfAssets", "objects", "nodeViewFiles", "canonicalLevels", "stageAliases", "files", "scenes", "rawObjects", "sourceBundles") if key in section)
        print("  %s: %s; errors=%s%s" % (name, section["status"], section["errors"], "; " + metrics if metrics else ""))
    for issue in report["errors"][:8]:
        print("  ERROR [%s] %s: %s" % (issue["section"], issue["code"], issue["file"]))
    if len(report["errors"]) > 8:
        print("  ... %d additional errors in report" % (len(report["errors"]) - 8))
    print("Report: " + str(report_path))
    return 1 if report["errors"] else (2 if report["deferred"] else 0)


if __name__ == "__main__":
    sys.exit(main())
