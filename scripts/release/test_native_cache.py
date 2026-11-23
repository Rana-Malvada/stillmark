import importlib.util, json, pathlib, shutil, sys, tempfile, unittest
from unittest.mock import patch

p = pathlib.Path(__file__).resolve().parents[2] / "workers/video-gpu/native"
spec = importlib.util.spec_from_file_location("native_cache", p / "native-cache.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class NativeIdentityTests(unittest.TestCase):
    def test_compiler_recipe_changes_real_identity(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            inputs = root / "inputs"
            inputs.mkdir()
            (inputs / "build.sh").write_text("build exact sources")
            recipe = root / "Dockerfile"
            recipe.write_text("FROM exact-base\nENV CFLAGS=-O2")
            tool = root / "gcc"
            tool.write_bytes(b"exact toolchain")

            def output(args, **kwargs):
                return str(tool) if args[0] == "which" else b"exact-package-versions"

            with (
                patch.object(m, "INPUTS", inputs),
                patch.object(m, "RECIPE", recipe),
                patch.object(m.subprocess, "check_output", side_effect=output),
            ):
                before = m.identity()
                recipe.write_text("FROM exact-base\nENV CFLAGS=-O3")
                after = m.identity()
                self.assertNotEqual(before["recipeSHA256"], after["recipeSHA256"])
                self.assertEqual(before["inputs"], after["inputs"])


class NativeCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)
        m.CACHE = self.root / "cache"
        m.EXPORT = self.root / "export"
        m.OUTPUT = self.root / "out"
        self.inputs = {"sources": "exact-pinned-source", "compiler": "exact-binary"}
        self.ident = patch.object(m, "identity", lambda: self.inputs.copy())
        self.ident.start()
        exe = m.OUTPUT / "usr/lib/ffmpeg"
        exe.parent.mkdir(parents=True)
        exe.write_bytes(b"compiled-native-artifact")

    def tearDown(self):
        self.ident.stop()
        self.temp.cleanup()

    def invoke(self, action):
        with patch.object(sys, "argv", ["cache", action]):
            m.main()

    def test_round_trip_preserves_files(self):
        original = m.file_manifest(m.OUTPUT)
        self.invoke("store")
        shutil.rmtree(m.OUTPUT)
        self.invoke("restore")
        self.assertEqual(m.file_manifest(m.OUTPUT), original)

    def test_changed_source_cannot_reuse_cache(self):
        self.invoke("store")
        self.inputs["sources"] = "changed"
        with self.assertRaises(SystemExit) as e:
            self.invoke("restore")
        self.assertEqual(e.exception.code, 3)

    def test_tampered_archive_rejected(self):
        self.invoke("store")
        next(m.CACHE.glob("*/runtime.tar.gz")).write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            self.invoke("restore")

    def test_external_symlink_rejected(self):
        (m.OUTPUT / "escape").symlink_to("/etc/passwd")
        with self.assertRaisesRegex(ValueError, "escapes"):
            self.invoke("store")

    def test_manifest_file_hash_mismatch_rejected(self):
        self.invoke("store")
        name = next(m.CACHE.glob("*/manifest.json"))
        data = json.loads(name.read_text())
        data["files"]["usr/lib/ffmpeg"]["sha256"] = "incorrect"
        name.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError, "manifest mismatch"):
            self.invoke("restore")


if __name__ == "__main__":
    unittest.main()
