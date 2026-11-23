"""Opt-in local-only conversion profiler; temporary media is always removed."""

import argparse, json, pathlib, subprocess, tempfile, time

p = argparse.ArgumentParser()
p.add_argument("input")
p.add_argument("--decoder-threads", type=int, choices=[1, 2, 3], default=2)
args = p.parse_args()
root = pathlib.Path(__file__).resolve().parent.parent
ffmpeg = str(root / "node_modules/ffmpeg-static/ffmpeg")
common = "scale=w='min(1920,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,setsar=1,fps=60000/1001"
zscale = "zscale=w='if(gte(iw,ih),min(1920,iw),-2)':h='if(gte(iw,ih),-2,min(1920,ih))':t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,setsar=1,fps=60000/1001"
report = []
with tempfile.TemporaryDirectory(prefix="video-profile-") as tmp:
    sample = str(pathlib.Path(tmp) / "sample.mov")
    subprocess.run(
        [
            ffmpeg,
            "-v",
            "error",
            "-i",
            args.input,
            "-t",
            "10",
            "-map",
            "0:v:0",
            "-an",
            "-c",
            "copy",
            sample,
        ],
        check=True,
    )
    for name, filters, encoder in [
        ("decode", None, None),
        ("current_normalization", common, None),
        ("zscale_normalization", zscale, None),
        (
            "current_veryfast_1thread",
            common,
            ["-c:v", "libx264", "-preset", "veryfast", "-threads", "1"],
        ),
        (
            "current_veryfast_2threads",
            common,
            ["-c:v", "libx264", "-preset", "veryfast", "-threads", "2"],
        ),
        (
            "zscale_veryfast_2threads",
            zscale,
            ["-c:v", "libx264", "-preset", "veryfast", "-threads", "2"],
        ),
    ]:
        cmd = [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-threads",
            str(args.decoder_threads),
            "-i",
            sample,
            "-filter_threads",
            "2",
        ]
        if filters:
            cmd += ["-vf", filters]
        if encoder:
            cmd += encoder + [
                "-crf",
                "18",
                "-maxrate",
                "8000k",
                "-bufsize",
                "16000k",
                "-force_key_frames",
                "expr:gte(t,n_forced*2)",
                "-sc_threshold",
                "0",
            ]
        cmd += ["-an", "-f", "null", "-"]
        start = time.monotonic()
        done = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
        row = {
            "name": name,
            "seconds": round(time.monotonic() - start, 3),
            "ok": done.returncode == 0,
            "decoderThreads": args.decoder_threads,
        }
        if done.returncode:
            row["error"] = done.stderr[-1500:]
        report.append(row)
        print(json.dumps(row), flush=True)
(root / "output/video-stage-profile.json").write_text(json.dumps(report, indent=2))
