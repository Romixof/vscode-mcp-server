/**
 * "Is this request from another VS Code window on this machine?"
 *
 * A loopback socket is NOT enough: Tailscale Funnel (and any reverse proxy or
 * tunnel) relays internet traffic from 127.0.0.1. A request only counts as
 * local when the socket is loopback, no proxy header is present, and the Host
 * header names a loopback address (a funnel request keeps its public
 * *.ts.net host).
 */

type HeaderBag = Record<string, string | string[] | undefined>;

const RELAY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-real-ip', 'via', 'cf-connecting-ip'];

export function isRelayedRequest(headers: HeaderBag): boolean {
    for (const name of RELAY_HEADERS) {
        if (headers[name] !== undefined) {
            return true;
        }
    }
    return Object.keys(headers).some(name => name.toLowerCase().startsWith('tailscale-'));
}

function isLoopbackAddress(address: string | undefined): boolean {
    if (!address) {
        return false;
    }
    const a = address.replace(/^::ffff:/i, '');
    return a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

function isLoopbackHost(host: string | string[] | undefined): boolean {
    if (typeof host !== 'string' || !host) {
        return false;
    }
    const h = host.trim().toLowerCase();
    return /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|\[::1\])(:\d{1,5})?$/.test(h);
}

export function isLocalPeer(req: { headers: HeaderBag; socket: { remoteAddress?: string } }): boolean {
    return isLoopbackAddress(req.socket.remoteAddress)
        && isLoopbackHost(req.headers.host)
        && !isRelayedRequest(req.headers);
}
