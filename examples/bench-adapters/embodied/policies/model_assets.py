"""Download and verify pinned model assets from the Hub or a matching mirror."""

import hashlib
import json
import os
import time
import urllib.parse
import urllib.request


class HubRedirect(urllib.request.HTTPRedirectHandler):
    """Forward the Hub token only to huggingface.co, not to the storage host a download redirects to."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is not None and urllib.parse.urlsplit(newurl).hostname != "huggingface.co":
            new.remove_header("Authorization")
        return new


def read_json(url):
    with urllib.request.urlopen(url, timeout=60) as response:
        return json.load(response)


def hashes(path, size):
    sha = hashlib.sha256()
    blob = hashlib.sha1(("blob " + str(size) + "\0").encode())
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            sha.update(block)
            blob.update(block)
    return sha.hexdigest(), blob.hexdigest()


def fetch(job, *, direct=False):
    repository, revision, file, destination, url, mirror = job
    size = file["size"]
    def verify(path):
        if path.stat().st_size != size:
            raise ValueError("asset size mismatch: " + file["rfilename"])
        sha, blob = hashes(path, size)
        if (sha != file["lfs"]["sha256"] if "lfs" in file else blob != file["blobId"]):
            raise ValueError("asset differs from pinned upstream content: " + file["rfilename"])
        if mirror is not None and sha != mirror["Sha256"]:
            raise ValueError("mirror checksum mismatch")
        return sha
    destination.parent.mkdir(parents=True, exist_ok=True)
    if not destination.exists():
        partial = destination.with_name(destination.name + ".partial")
        for attempt in range(4):
            try:
                offset = partial.stat().st_size if partial.exists() else 0
                if offset == size:
                    verify(partial)
                    partial.replace(destination)
                    break
                if offset > size:
                    raise ValueError("partial asset exceeds expected size: " + file["rfilename"])
                headers = {"Range": "bytes=" + str(offset) + "-"} if offset else {}
                if url.startswith("https://huggingface.co/") and os.environ.get("HF_TOKEN"):
                    headers["Authorization"] = "Bearer " + os.environ["HF_TOKEN"]
                handlers = [HubRedirect()] + ([urllib.request.ProxyHandler({})] if direct else [])
                with urllib.request.build_opener(*handlers).open(urllib.request.Request(url, headers=headers), timeout=120) as response:
                    append = offset > 0 and response.status == 206
                    if append and response.headers.get("Content-Range", "").split("/", 1)[0] != "bytes " + str(offset) + "-" + str(size - 1):
                        raise ValueError("download resume returned an unexpected byte range")
                    with partial.open("ab" if append else "wb") as stream:
                        for block in iter(lambda: response.read(8 * 1024 * 1024), b""):
                            stream.write(block)
                verify(partial)
                partial.replace(destination)
                break
            except Exception:
                if attempt == 3:
                    raise
                time.sleep(2)
    checksum = verify(destination)
    print("Verified " + repository + "/" + file["rfilename"], flush=True)
    return {"repository": repository, "revision": revision, "path": file["rfilename"],
            "bytes": size, "sha256": checksum, "officialBlob": file["blobId"]}
