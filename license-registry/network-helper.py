#!/usr/bin/env python3
"""One bounded API request using macOS/system proxy settings; never prints the key."""
import argparse
import json
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
            body = raw.decode('utf-8', 'replace').replace(key, '[REDACTED]')
            try:
                payload = json.loads(body)
            except ValueError:
                payload = {'non_json_response': body[:1500]}
            result = {'http_status': response.status, 'response': payload, 'attempted': True}
    except urllib.error.HTTPError as error:
        body = error.read(1500).decode('utf-8', 'replace')
        result = {'http_status': error.code, 'error': body.replace(key, '[REDACTED]') if key else body,
                  'attempted': attempted}
    except Exception as error:
        text = str(error)
        result = {'transport_error': text.replace(key, '[REDACTED]') if key else text,
                  'attempted': attempted}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
