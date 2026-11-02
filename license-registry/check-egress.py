#!/usr/bin/env python3
"""One read-only, bounded HTTPS probe; never prints proxy credentials."""
import ipaddress
import json
import os
import ssl
import sys
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main():
    result = {'type': 'fixie_egress_probe', 'ok': False}
    try:
        proxy = os.environ.get('FSRAR_PROXY_URL', '')
        parsed = urllib.parse.urlsplit(proxy)
        expected = str(ipaddress.IPv4Address(parsed.hostname or ''))
        if (parsed.scheme not in ('http', 'https') or not parsed.username
                or not parsed.password or parsed.path not in ('', '/')
                or parsed.query or parsed.fragment
                or (parsed.port is not None and not 1 <= parsed.port <= 65535)):
            raise ValueError()
        # This isolated probe must not inherit an exception that bypasses Fixie.
        os.environ['NO_PROXY'] = ''
        os.environ['no_proxy'] = ''
        opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({'http': proxy, 'https': proxy}),
            urllib.request.HTTPSHandler(context=ssl.create_default_context()),
            NoRedirect)
        request = urllib.request.Request('https://api.ipify.org?format=json',
                                         headers={'Accept': 'application/json'})
        with opener.open(request, timeout=20) as response:
            raw = response.read(4097)
            if response.status != 200 or len(raw) > 4096:
                raise ValueError()
        observed = str(ipaddress.IPv4Address(json.loads(raw)['ip']))
        result.update(ok=observed == expected, observedIp=observed, expectedIp=expected)
    except Exception as error:
        # Exception messages can contain a proxy URL or credentials. Emit class only.
        result['errorClass'] = type(error).__name__
    print(json.dumps(result))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
