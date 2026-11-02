#!/usr/bin/env python3
"""One bounded API request using macOS/system proxy settings; never prints the key."""
import argparse
import base64
import json
import os
import pathlib
import re
import stat
import sys
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def redact(text, key='', proxy_urls=None):
    """Proxy credentials can appear in urllib exception text or a proxy's HTML error page."""
    secrets = [(key, '[REDACTED]')] if key else []
    urls = proxy_urls if proxy_urls is not None else [
        value for name, value in os.environ.items()
        if name.lower() in ('http_proxy', 'https_proxy', 'all_proxy') and value]
    for proxy_url in urls:
        secrets.extend([(proxy_url, '[REDACTED_PROXY]'),
                        (urllib.parse.unquote(proxy_url), '[REDACTED_PROXY]')])
        try:
            parsed = urllib.parse.urlsplit(proxy_url)
            if parsed.password:
                password = urllib.parse.unquote(parsed.password)
                secrets.extend([(parsed.password, '[REDACTED_PROXY]'),
                                (password, '[REDACTED_PROXY]')])
                if parsed.username:
                    username = urllib.parse.unquote(parsed.username)
                    encoded_auth = base64.b64encode((username + ':' + password).encode()).decode()
                    secrets.append((encoded_auth, '[REDACTED_PROXY]'))
        except ValueError:
            pass
    result = str(text)
    for secret, replacement in sorted(secrets, key=lambda item: len(item[0]), reverse=True):
        if secret:
            result = result.replace(secret, replacement)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--key-file', required=True)
    parser.add_argument('--method', choices=['fsrar', 'stat', 'validate'], default='fsrar')
    parser.add_argument('--inn')
    parser.add_argument('--kpp')
    parser.add_argument('--timeout', type=float, default=20)
    args = parser.parse_args()
    key = ''
    attempted = False
    try:
        key_path = pathlib.Path(args.key_file)
        if stat.S_IMODE(key_path.stat().st_mode) & 0o077:
            raise ValueError('Key file must not be readable by group or other users')
        key = key_path.read_text().strip()
        if not re.fullmatch(r'[A-Za-z0-9_-]{40}', key):
            raise ValueError('Key file does not contain a valid 40-character key')
        if args.method == 'validate':
            print(json.dumps({'valid': True, 'attempted': False}))
            return
        fields = {'key': key}
        if args.method == 'fsrar':
            if not re.fullmatch(r'\d{10}(\d{2})?', args.inn or ''):
                raise ValueError('A numeric corporate INN is required')
            fields['inn'] = args.inn
            if args.kpp:
                if not re.fullmatch(r'\d{9}', args.kpp):
                    raise ValueError('KPP must contain 9 digits')
                fields['kpp'] = args.kpp
        request = urllib.request.Request(
            'https://api-fns.ru/api/' + args.method,
            data=urllib.parse.urlencode(fields).encode(),
            headers={'Content-Type': 'application/x-www-form-urlencoded',
                     'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0'})
        # The default ProxyHandler is intentional: direct TLS may fail on this Mac.
        opener = urllib.request.build_opener(NoRedirect)
        attempted = True
        with opener.open(request, timeout=min(max(args.timeout, 1), 20)) as response:
            raw = response.read(2_000_001)
            if len(raw) > 2_000_000:
                raise ValueError('API response exceeds the bounded read limit')
            body = redact(raw.decode('utf-8', 'replace'), key)
            try:
                payload = json.loads(body)
            except ValueError:
                payload = {'non_json_response': body[:1500]}
            result = {'http_status': response.status, 'response': payload, 'attempted': True}
    except urllib.error.HTTPError as error:
        body = error.read(1500).decode('utf-8', 'replace')
        result = {'http_status': error.code, 'error': redact(body, key),
                  'attempted': attempted}
    except Exception as error:
        result = {'transport_error': redact(str(error), key),
                  'attempted': attempted}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
