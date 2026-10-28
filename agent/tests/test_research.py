from winagent.research import classify_trust, decode_result_url, is_public_host, select_sources


def ddg(url):
    from urllib.parse import quote

    return f"//duckduckgo.com/l/?uddg={quote(url, safe='')}&rut=abc"


def test_decodes_duckduckgo_redirects():
    assert decode_result_url(ddg("https://docs.python.org/3/whatsnew/3.13.html")) == "https://docs.python.org/3/whatsnew/3.13.html"
    assert decode_result_url("https://example.com/a") == "https://example.com/a"
    assert decode_result_url(None) is None


def test_trust_tiers():
    assert classify_trust("www.nasa.gov") == "official"
    assert classify_trust("www.ox.ac.uk") == "official"
    assert classify_trust("docs.python.org") == "official"
    assert classify_trust("learn.microsoft.com") == "official"
    assert classify_trust("en.wikipedia.org") == "reference"
    assert classify_trust("someblog.example.com") == "general"


def test_private_hosts_are_not_public():
    for host in ("localhost", "127.0.0.1", "10.0.0.5", "192.168.1.1", "printer.local", "intranet"):
        assert not is_public_host(host), host
    assert is_public_host("example.com") and is_public_host("8.8.8.8")


def test_selection_ranks_filters_and_keeps_one_page_per_domain():
    hrefs = [
        ddg("https://blog.example.com/post"),
        ddg("https://blog.example.com/another"),  # same domain: ignored
        ddg("https://en.wikipedia.org/wiki/Python"),
        ddg("http://192.168.0.10/admin"),  # private
        ddg("https://bad.example.net/page"),  # denied by policy
        ddg("https://files.example.org/setup.exe"),  # executable
        "//duckduckgo.com/y.js?ad_provider=x",  # advert, no uddg target
        ddg("https://docs.python.org/3/"),
    ]
    selected, skipped = select_sources(hrefs, 3, ["*.example.net"])
    assert [(s["domain"], s["trust"]) for s in selected] == [("docs.python.org", "official"), ("en.wikipedia.org", "reference"), ("blog.example.com", "general")]
    assert {s["reason"] for s in skipped} == {"private or local address", "denied by website policy", "executable file"}


def test_selection_respects_the_limit():
    hrefs = [ddg(f"https://site{i}.example.com/") for i in range(10)]
    selected, _ = select_sources(hrefs, 2, [])
    assert len(selected) == 2
