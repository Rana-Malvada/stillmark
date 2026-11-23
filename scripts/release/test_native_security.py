import copy, hashlib, importlib.util, json, pathlib, subprocess, tempfile, unittest
from unittest.mock import patch

p = pathlib.Path(__file__).parent
spec = importlib.util.spec_from_file_location("native_security", p / "native_security.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class NativePolicyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)
        self.native = self.root / "native"
        self.native.mkdir()
        (self.root / "worker.ts").write_text("fixed execution path")
        self.policy = {
            "architecture": "x64",
            "components": {"ffmpeg": "8.1.3"},
            "sourceBindings": {"worker.ts": m.sha256(self.root / "worker.ts")},
            "findings": [
                {
                    "component": "ffmpeg",
                    "version": "8.1.3",
                    "cve": "CVE-test",
                    "status": "configured-path-excluded",
                    "reason": "Only fixed encoder selection",
                    "evidence": ["worker.ts"],
                }
            ],
            "limitations": ["CPE discovery is not exhaustive"],
        }
        (self.native / "components.cdx.json").write_text(
            json.dumps({"components": [{"name": "ffmpeg", "version": "8.1.3"}]})
        )
        (self.native / "source-lock.json").write_text("{}")
        self.write_policy()
        self.inventory = {
            "architecture": "x64",
            "files": [{"component": "ffmpeg", "version": "8.1.3"}],
            "metadata": {
                n: m.sha256(self.native / n)
                for n in ["components.cdx.json", "source-lock.json", "applicability.json"]
            },
        }
        self.report = {
            "matches": [
                {
                    "artifact": {"name": "ffmpeg", "version": "8.1.3"},
                    "vulnerability": {"id": "CVE-test", "severity": "High"},
                }
            ]
        }

    def tearDown(self):
        self.temp.cleanup()

    def write_policy(self):
        (self.native / "applicability.json").write_text(json.dumps(self.policy))

    def test_review_retains_unpatched_advisory(self):
        policy, versions = m.validate_bindings(self.inventory, self.native, self.root)
        r = m.summarize_native(self.report, policy, versions)
        self.assertEqual(r["blocking"], [])
        self.assertEqual(len(r["retainedUnpatchedHighCritical"]), 1)

    def test_source_change_invalidates_review(self):
        (self.root / "worker.ts").write_text("new execution path")
        with self.assertRaisesRegex(ValueError, "stale"):
            m.validate_bindings(self.inventory, self.native, self.root)

    def test_new_advisory_blocks(self):
        self.report["matches"][0]["vulnerability"]["id"] = "CVE-new"
        r = m.summarize_native(self.report, self.policy, self.policy["components"])
        self.assertEqual(len(r["blocking"]), 1)

    def test_new_dependency_blocks(self):
        self.inventory["files"].append({"component": "newlib", "version": "1"})
        with self.assertRaisesRegex(ValueError, "inventory"):
            m.validate_bindings(self.inventory, self.native, self.root)

    def test_wrong_architecture_blocks(self):
        self.inventory["architecture"] = "arm64"
        with self.assertRaisesRegex(ValueError, "architecture"):
            m.validate_bindings(self.inventory, self.native, self.root)

    def test_metadata_change_blocks(self):
        (self.native / "source-lock.json").write_text('{"changed":true}')
        with self.assertRaisesRegex(ValueError, "metadata"):
            m.validate_bindings(self.inventory, self.native, self.root)

    def test_review_requires_reason_and_evidence(self):
        self.policy["findings"][0]["evidence"] = []
        r = m.summarize_native(self.report, self.policy, self.policy["components"])
        self.assertEqual(len(r["blocking"]), 1)

    def test_unbound_scanner_component_blocks(self):
        self.report["matches"][0]["artifact"]["version"] = "8.2"
        with self.assertRaisesRegex(ValueError, "unbound"):
            m.summarize_native(self.report, self.policy, self.policy["components"])


class NativePatchPreflightTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)
        self.ffmpeg = self.root / "ffmpeg"
        self.zlib = self.root / "zlib"
        self.ffmpeg.mkdir()
        self.zlib.mkdir()
        spec = importlib.util.spec_from_file_location(
            "native_fetch", pathlib.Path(__file__).resolve().parents[2]
            / "workers/video-gpu/native/fetch-inputs.py"
        )
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        for patch, filename, directory, current in [
            ("cfhd-official.patch", "cfhd.c", self.ffmpeg, "fixed"),
            ("flic-official.patch", "flic.c", self.ffmpeg, "old"),
            ("zlib-official.patch", "zlib.c", self.zlib, "old"),
        ]:
            (directory / filename).write_text(current + "\n")
            (self.root / patch).write_text(
                f"diff --git a/{filename} b/{filename}\n--- a/{filename}\n+++ b/{filename}\n"
                "@@ -1 +1 @@\n-old\n+fixed\n"
            )

    def tearDown(self):
        self.temp.cleanup()

    def test_requires_inherited_fix_and_applies_only_missing_ffmpeg_patch(self):
        self.module.preflight_patches(self.root, self.ffmpeg, self.zlib)
        self.assertEqual((self.ffmpeg / "cfhd.c").read_text(), "fixed\n")
        self.assertEqual((self.ffmpeg / "flic.c").read_text(), "fixed\n")
        self.assertEqual((self.zlib / "zlib.c").read_text(), "old\n")

    def test_absent_inherited_fix_or_changed_patch_source_fails_before_applying(self):
        for path, state in [(self.ffmpeg / "cfhd.c", "old"),
                            (self.ffmpeg / "cfhd.c", "unknown"),
                            (self.zlib / "zlib.c", "unknown")]:
            original = path.read_text()
            path.write_text(state + "\n")
            with self.subTest(path=path, state=state), self.assertRaises(subprocess.CalledProcessError):
                self.module.preflight_patches(self.root, self.ffmpeg, self.zlib)
            self.assertEqual((self.ffmpeg / "flic.c").read_text(), "old\n")
            path.write_text(original)


class NativeBuildPolicyTests(unittest.TestCase):
    def setUp(self):
        native = pathlib.Path(__file__).resolve().parents[2] / "workers/video-gpu/native"
        self.modules = {}
        for name in ("build-parallelism", "fetch-inputs", "verify-built-libraries"):
            spec = importlib.util.spec_from_file_location(name, native / (name + ".py"))
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            self.modules[name] = module

    def test_cpu_affinity_quota_and_policy_all_bound_jobs(self):
        choose = self.modules["build-parallelism"].choose_jobs
        for count, expected in [(1, 1), (2, 2), (16, 16), (32, 16)]:
            self.assertEqual(choose(16, count, count, []), expected)
        self.assertEqual(choose(16, 32, 3, [(-1, 100000)]), 3)
        self.assertEqual(choose(16, 32, 16, [(250000, 100000)]), 2)
        self.assertEqual(choose(16, 32, 16, [(50000, 100000)]), 1)
        self.assertEqual(choose(4, 32, 16, []), 4)
        for cap in [None, 0, -1, 17, "16", True]:
            with self.subTest(cap=cap), self.assertRaises(ValueError):
                choose(cap, 16, 16, [])
        with self.assertRaises(ValueError):
            choose(16, 16, 16, [(100000, 0)])

    def test_cgroup_ancestors_and_v1_are_inspected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            (root / "child").mkdir()
            (root / "cpu.max").write_text("800000 100000")
            (root / "child/cpu.max").write_text("max 100000")
            membership = root / "membership"
            membership.write_text("0::/child\n")
            quotas = self.modules["build-parallelism"].cgroup_quotas(root, membership)
            self.assertIn((800000, 100000), quotas)
            self.assertIn((-1, 100000), quotas)
            (root / "cpu").mkdir()
            (root / "cpu/cpu.cfs_quota_us").write_text("200000")
            (root / "cpu/cpu.cfs_period_us").write_text("100000")
            self.assertIn((200000, 100000), self.modules["build-parallelism"].cgroup_quotas(root, membership))
            (root / "cpu.max").write_text("broken")
            with self.assertRaises(ValueError):
                self.modules["build-parallelism"].cgroup_quotas(root, membership)

    def test_fate_rejects_old_donor_libraries_and_wrong_paths(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            source = root / "source"
            prefix = root / "installed"
            source.mkdir(parents=True)
            prefix.mkdir()
            built = source / "libavcodec.so.62"
            loaded = prefix / "libavcodec.so.62"
            built.write_bytes(b"patched decoder")
            loaded.write_bytes(b"old donor decoder")
            verify = self.modules["verify-built-libraries"].verify_dependencies
            output = f"libavcodec.so.62 => {loaded} (0x00)"
            with self.assertRaisesRegex(ValueError, "different native build"):
                verify(output, source, prefix)
            loaded.write_bytes(built.read_bytes())
            self.assertEqual(verify(output, source, prefix)[0]["sha256"], m.sha256(built))
            with self.assertRaisesRegex(ValueError, "Missing verified native"):
                verify(output, source, prefix, ("libavcodec", "libavformat"))
            with self.assertRaisesRegex(ValueError, "Duplicate"):
                verify(output + "\n" + output, source, prefix)
            with self.assertRaisesRegex(ValueError, "resolution"):
                verify(f"libavcodec.so.62 => {built} (0x00)", source, prefix)
            with self.assertRaisesRegex(ValueError, "Missing verified native"):
                verify("libc.so.6 => /lib/libc.so.6", source, prefix)

    def test_distinct_system_xml_abi_requires_real_package_ownership(self):
        module = self.modules["verify-built-libraries"]
        path = "/usr/lib/x86_64-linux-gnu/libxml2.so.2.9.14"
        output = f"libxml2.so.2 => {path} (0x00)"
        with patch.object(pathlib.Path, "resolve", lambda value: value), \
             patch.object(pathlib.Path, "read_bytes", return_value=b"system XML"), \
             patch.object(module.subprocess, "check_output", return_value=f"libxml2:amd64: {path}") as owner:
            result = module.verify_dependencies(output, pathlib.Path("/staged"), pathlib.Path("/native"), ())
            self.assertIn("osPackage", result[0])
            owner.return_value = "unknown: " + path
            with self.assertRaisesRegex(ValueError, "Unowned"):
                module.verify_dependencies(output, pathlib.Path("/staged"), pathlib.Path("/native"), ())
            with self.assertRaisesRegex(ValueError, "system XML library path"):
                module.verify_dependencies(output.replace("/usr/lib/x86_64-linux-gnu", "/tmp"), pathlib.Path("/staged"), pathlib.Path("/native"), ())

    def test_runtime_inventory_rejects_retained_or_replaced_donor_xml(self):
        helper = pathlib.Path(__file__).resolve().parents[2] / "workers/video-gpu/native/artifact-integrity.cjs"
        script = """
const verify = require(process.argv[1]); const assert = require('node:assert/strict');
const manifest = {files:{'lib/libxml2.so.16.1.4': 'patched'},symlinks:{}};
const files = [{path:'lib/libxml2.so.16.1.4',sha256:'patched',component:'libxml2'}];
verify(files, manifest);
assert.throws(()=>verify([...files,{path:'lib/libxml2.so.16.1.3',sha256:'old',component:'libxml2'}],manifest),/donor/);
assert.throws(()=>verify([{...files[0],sha256:'old'}],manifest),/does not match/);
assert.throws(()=>verify([],manifest),/does not match/);
assert.throws(()=>verify(files,{}),/Missing/);
assert.throws(()=>verify(files,manifest,[{path:'lib/libxml2.so.16',target:'old'}]),/donor symlink/);
assert.throws(()=>verify(files,{...manifest,symlinks:{'lib/libxml2.so.16':'libxml2.so.16.1.4'}},[]),/symlink does not match/);
"""
        subprocess.run(["node", "-e", script, str(helper)], check=True)

    def test_vendor_patch_order_integrity_and_failure_are_enforced(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            source = root / "source"
            patches = source / "debian/patches"
            patches.mkdir(parents=True)
            (source / "file.c").write_text("old\n")
            names = ["first.patch", "second.patch"]
            for name, before, after in [(names[0], "old", "middle"), (names[1], "middle", "fixed")]:
                (patches / name).write_text(
                    "diff --git a/file.c b/file.c\n--- a/file.c\n+++ b/file.c\n"
                    f"@@ -1 +1 @@\n-{before}\n+{after}\n"
                )
            series = patches / "series"
            series.write_text("\n".join(names) + "\n")
            policy = {"vendorPatches": {"count": 2, "seriesSHA256": m.sha256(series)}}
            (root / "build-inputs.json").write_text(json.dumps(policy))
            apply = self.modules["fetch-inputs"].apply_vendor_patches
            apply(root, source)
            self.assertEqual((source / "file.c").read_text(), "fixed\n")
            with self.assertRaises(subprocess.CalledProcessError):
                apply(root, source)
            series.write_text("second.patch\nfirst.patch\n")
            with self.assertRaisesRegex(ValueError, "checksum"):
                apply(root, source)
            series.write_text("../escape.patch\n")
            policy["vendorPatches"] = {"count": 1, "seriesSHA256": m.sha256(series)}
            (root / "build-inputs.json").write_text(json.dumps(policy))
            with self.assertRaisesRegex(ValueError, "path"):
                apply(root, source)

    def test_unstable_test_registration_matches_both_library_configurations(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            files = {
                "tests/checkasm/Makefile": "CHECKASMOBJS = tests/checkasm/sw_scale.o\nifeq ($(CONFIG_UNSTABLE),yes)\nCHECKASMOBJS += tests/checkasm/sw_ops.o\nendif\n",
                "tests/fate/checkasm.mak": "FATE_CHECKASM = fate-checkasm-sw_scale\nifeq ($(CONFIG_UNSTABLE),yes)\nFATE_CHECKASM += fate-checkasm-sw_ops\nendif\n",
                "libswscale/Makefile": "TESTPROGS = swscale\nTESTPROGS-$(CONFIG_UNSTABLE) += sws_ops\n",
                "tests/checkasm/checkasm.c": '#if CONFIG_SWSCALE\n{"sw_scale", checkasm_check_sw_scale},\n#if CONFIG_UNSTABLE\n{"sw_ops", checkasm_check_sw_ops},\n#endif\n#endif\n#if CONFIG_AVUTIL\n#endif\n',
            }
            for name, text in files.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text)
            verify = self.modules["fetch-inputs"].verify_test_registration
            verify(root)
            # Every layer must match; one unguarded object, target, program or
            # registration independently reproduces an invalid configuration.
            for name, text in files.items():
                path = root / name
                if name.endswith(".c"):
                    broken = text.replace("#if CONFIG_UNSTABLE", "#if 1")
                elif "TESTPROGS-" in text:
                    broken = text.replace("TESTPROGS-$(CONFIG_UNSTABLE)", "TESTPROGS")
                else:
                    broken = text.replace("ifeq ($(CONFIG_UNSTABLE),yes)", "ifeq (yes,yes)")
                path.write_text(broken)
                with self.subTest(name=name), self.assertRaisesRegex(ValueError, "do(?:es)? not match"):
                    verify(root)
                path.write_text(text)


class RepositoryReviewTests(unittest.TestCase):
    def test_current_source_matches_explicit_review(self):
        root = pathlib.Path(__file__).resolve().parents[2]
        native = root / "workers/video-gpu/native"
        bom = json.loads((native / "components.cdx.json").read_text())
        inventory = {
            "architecture": "x64",
            "files": [{"component": c["name"], "version": c["version"]} for c in bom["components"]],
            "metadata": {
                name: m.sha256(native / name)
                for name in ("components.cdx.json", "source-lock.json", "applicability.json")
            },
        }
        m.validate_bindings(inventory, native, root)

    def test_official_patch_checksums_and_public_sources_are_locked(self):
        native = pathlib.Path(__file__).resolve().parents[2] / "workers/video-gpu/native"
        inputs = json.loads((native / "build-inputs.json").read_text())
        for name, expected in inputs["patches"].items():
            self.assertEqual(m.sha256(native / name), expected)
        sources = json.loads((native / "vendor-dependency-lock.json").read_text())
        for source in sources:
            self.assertTrue(source["url"].startswith("https://"))
            self.assertRegex(
                source.get("commit") or source.get("sha256"), r"^(?:[a-f0-9]{40}|[a-f0-9]{64})$"
            )


if __name__ == "__main__":
    unittest.main()
