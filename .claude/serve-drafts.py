import http.server, functools, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", ".superdesign", "drafts")


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # 设计稿总在改：别让浏览器拿旧的那版（iframe 里的 desk.css 尤其容易吃缓存）
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        super().end_headers()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8791
    handler = functools.partial(NoCache, directory=ROOT)
    http.server.ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
