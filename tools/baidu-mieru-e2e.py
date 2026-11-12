"""Loopback integration test for the fork's mieru inbound, outbound and detour.

All accounts and traffic are synthetic. Run: python3 tools/baidu-mieru-e2e.py PATH_TO_SING_BOX
"""
import json
import os
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time


def free_port(sock_type):
    with socket.socket(socket.AF_INET, sock_type) as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def read_exact(sock, size):
    data = b''
    while len(data) < size:
        chunk = sock.recv(size - len(data))
        if not chunk:
            raise EOFError('connection closed before response')
        data += chunk
    return data


def echo_tcp(listener):
    def handle(conn):
        with conn:
            try:
                while True:
                    data = conn.recv(65536)
                    if not data:
                        return
                    conn.sendall(data)
            except OSError:
                return
    while True:
        try:
            conn, _ = listener.accept()
            threading.Thread(target=handle, args=(conn,), daemon=True).start()
        except OSError:
            return


def echo_udp(listener):
    while True:
        try:
            data, addr = listener.recvfrom(65536)
            listener.sendto(data, addr)
        except OSError:
            return


def socks_connect(port):
    sock = socket.create_connection(('127.0.0.1', port), timeout=10)
    sock.settimeout(10)
    sock.sendall(b'\x05\x01\x00')
    if read_exact(sock, 2) != b'\x05\x00':
        sock.close()
        raise AssertionError('SOCKS negotiation failed')
    return sock


def socks_request(sock, command, host, port):
    sock.sendall(b'\x05' + bytes([command]) + b'\x00\x01' + socket.inet_aton(host) + struct.pack('!H', port))
    head = read_exact(sock, 4)
    if head[:2] != b'\x05\x00' or head[3] != 1:
        raise AssertionError('SOCKS request rejected: ' + repr(head))
    host = socket.inet_ntoa(read_exact(sock, 4))
    port = struct.unpack('!H', read_exact(sock, 2))[0]
    return host, port


def exercise(binary, transport, tcp_echo_port, udp_echo_port):
    mieru_port = free_port(socket.SOCK_STREAM if transport == 'TCP' else socket.SOCK_DGRAM)
    socks_port = free_port(socket.SOCK_STREAM)
    relay_port = free_port(socket.SOCK_STREAM)
    config = {
        'log': {'level': 'info'},
        'dns': {'servers': [{'type': 'hosts', 'tag': 'hosts',
                             'predefined': {'mieru-test.invalid': '127.0.0.1'}}]},
        'inbounds': [
            {'type': 'mieru', 'tag': 'server', 'listen': '127.0.0.1', 'listen_port': mieru_port,
             'transport': transport, 'users': [{'name': 'test-user', 'password': 'test-password'}]},
            {'type': 'socks', 'tag': 'client', 'listen': '127.0.0.1', 'listen_port': socks_port},
            {'type': 'socks', 'tag': 'relay-in', 'listen': '127.0.0.1', 'listen_port': relay_port},
        ],
        'outbounds': [
            {'type': 'mieru', 'tag': 'm', 'server': 'mieru-test.invalid', 'server_port': mieru_port,
             'transport': transport, 'username': 'test-user', 'password': 'test-password', 'detour': 'relay',
             'domain_resolver': {'server': 'hosts', 'strategy': 'ipv4_only'}},
            {'type': 'socks', 'tag': 'relay', 'server': '127.0.0.1', 'server_port': relay_port},
            {'type': 'direct', 'tag': 'direct'},
        ],
        'route': {'rules': [
            {'inbound': ['server', 'relay-in'], 'outbound': 'direct'},
            {'inbound': 'client', 'outbound': 'm'},
        ]},
    }
    if transport == 'TCP':
        # With detour and no explicit resolver, the relay receives the domain.
        del config['outbounds'][0]['domain_resolver']
    with tempfile.TemporaryDirectory(prefix='mieru-e2e-') as directory:
        config_path = os.path.join(directory, 'config.json')
        log_path = os.path.join(directory, 'output.log')
        with open(config_path, 'w', encoding='utf-8') as stream:
            json.dump(config, stream)
        with open(log_path, 'w+', encoding='utf-8', errors='replace') as log:
            process = subprocess.Popen([binary, 'run', '-c', config_path], stdout=log, stderr=subprocess.STDOUT)
            try:
                for _ in range(100):
                    if process.poll() is not None:
                        raise RuntimeError('sing-box exited before starting')
                    try:
                        with socket.create_connection(('127.0.0.1', socks_port), timeout=0.2):
                            break
                    except OSError:
                        time.sleep(0.1)
                else:
                    raise TimeoutError('sing-box SOCKS listener did not start')

                with socks_connect(socks_port) as tcp:
                    socks_request(tcp, 1, '127.0.0.1', tcp_echo_port)
                    tcp.sendall(b'mieru tcp echo')
                    if read_exact(tcp, 14) != b'mieru tcp echo':
                        raise AssertionError('TCP echo mismatch')
                with socks_connect(socks_port) as control:
                    relay_address = socks_request(control, 3, '0.0.0.0', 0)
                    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
                        udp.settimeout(10)
                        header = b'\x00\x00\x00\x01' + socket.inet_aton('127.0.0.1') + struct.pack('!H', udp_echo_port)
                        udp.sendto(header + b'mieru udp echo', relay_address)
                        result, _ = udp.recvfrom(65536)
                        if result != header + b'mieru udp echo':
                            raise AssertionError('UDP echo mismatch')
                log.flush()
                log.seek(0)
                log_text = log.read()
                relay_action = 'inbound packet connection to' if transport == 'UDP' else 'inbound connection to'
                relay_destination = ('127.0.0.1' if transport == 'UDP' else 'mieru-test.invalid') + ':' + str(mieru_port)
                if not any('inbound/socks[relay-in]: ' + relay_action + ' ' + relay_destination in line
                           for line in log_text.splitlines()):
                    raise AssertionError('traffic did not pass through the SOCKS detour with the expected server address')
                print(f'{transport} transport: TCP and UDP through mieru and SOCKS detour passed')
            except Exception:
                log.flush()
                log.seek(0)
                print(log.read(), file=sys.stderr)
                raise
            finally:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)


def main():
    if len(sys.argv) != 2:
        raise SystemExit('Usage: python3 tools/baidu-mieru-e2e.py PATH_TO_SING_BOX')
    binary = os.path.abspath(sys.argv[1])
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as tcp_echo, socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp_echo:
        tcp_echo.bind(('127.0.0.1', 0))
        tcp_echo.listen()
        udp_echo.bind(('127.0.0.1', 0))
        threading.Thread(target=echo_tcp, args=(tcp_echo,), daemon=True).start()
        threading.Thread(target=echo_udp, args=(udp_echo,), daemon=True).start()
        for transport in ('TCP', 'UDP'):
            exercise(binary, transport, tcp_echo.getsockname()[1], udp_echo.getsockname()[1])


if __name__ == '__main__':
    main()
