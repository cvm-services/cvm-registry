#!/usr/bin/env python3
"""Find the Caddyfile spelling that really produces 308 + Location: /api/ on 2.6.2.

Adapt-only probe: for each candidate directive body, build a one-handle Caddyfile, run
`caddy adapt`, and report the static_response status/headers (or the parse error).
"""
import json
import subprocess
import tempfile
import os

CADDY = "/home/c03rad0r/scratch/caddy2/root/usr/bin/caddy"
SC = "/home/c03rad0r/scratch/t_cdc4442b"

CANDIDATES = {
    "a_redir_path_code": "\t\tredir /api/ 308\n",
    "c_redir_quoted": '\t\tredir "/api/" 308\n',
    "d_redir_star": "\t\tredir * /api/ 308\n",
    "e_route_redir": "\t\troute {\n\t\t\tredir /api/ 308\n\t\t}\n",
    "f_respond_hdr": '\t\trespond "moved" 308 {\n\t\t\tLocation /api/\n\t\t}\n',
    "h_redir_permanent": "\t\tredir /api/ permanent\n",
    "j_redir_code_first": "\t\tredir 308 /api/\n",
    "k_respond_empty_hdr": '\t\trespond "" 308 {\n\t\t\tLocation /api/\n\t\t}\n',
    "l_redir_full_url": "\t\tredir https://{http.request.host}/api/ 308\n",
    "m_redir_placeholder": "\t\tredir {http.request.uri}/ 308\n",
}


def probe(name, body):
    cfg = ":19999 {\n\thandle /api {\n%s\t}\n}\n" % body
    path = os.path.join(SC, "probe-%s.caddyfile" % name)
    with open(path, "w") as fh:
        fh.write(cfg)
    proc = subprocess.run(
        [CADDY, "adapt", "--config", path, "--adapter", "caddyfile", "--pretty"],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        print("%-22s PARSE-ERROR %s" % (name, proc.stderr.strip().splitlines()[-1][:150]))
        return
    data = json.loads(proc.stdout)
    routes = data["apps"]["http"]["servers"]["srv0"]["routes"]
    found = []

    def walk(rs, outer):
        for r in rs:
            inner_match = json.dumps(r.get("match", []))
            for x in r.get("handle", []):
                if x.get("handler") == "subroute":
                    walk(x["routes"], json.dumps(r.get("match", [])))
                elif x.get("handler") == "static_response":
                    found.append((
                        inner_match,
                        x.get("status_code"),
                        json.dumps(x.get("headers", {})),
                        json.dumps(x.get("body", ""))[:40],
                    ))

    walk(routes, "-")
    if not found:
        print("%-22s ADAPTED but no static_response: %s" % (name, json.dumps(routes)[:160]))
    for inner_match, code, headers, body in found:
        print("%-22s inner-match=%-18s status=%-4s headers=%-30s body=%s"
              % (name, inner_match, code, headers, body))


for name, body in CANDIDATES.items():
    probe(name, body)
