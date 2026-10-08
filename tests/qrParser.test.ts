import { parseQRPayload } from '../src/payments/qrParser';
import { PaymentParseError } from '../src/errors/payment-errors';

describe('QR Parser', () => {
  test('parses valid QR payload', () => {
    const url = 'pocketpay://pay?address=GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H&amount=10.5&asset=USD:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5&memo=hello&metadata=key1%3Avalue1%2Ckey2%3Avalue2';
    const result = parseQRPayload(url);
    expect(result.address).toBe('GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H');
    expect(result.amount).toBe('10.5');
    expect(result.asset).toEqual({ code: 'USD', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' });
    expect(result.memo).toBe('hello');
    expect(result.metadata).toEqual({ key1: 'value1', key2: 'value2' });
  });

  test('preserves a literal percent in metadata values', () => {
    const url = 'pocketpay://pay?address=GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H&amount=1&metadata=note%3A99%25%20complete';
    expect(parseQRPayload(url).metadata).toEqual({ note: '99% complete' });
  });

  test('preserves additional colons in metadata values', () => {
    const url = 'pocketpay://pay?address=GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H&amount=1&metadata=url%3Ahttps%3A%2F%2Fexample.com%3A8443%2Fa%3Ab';
    expect(parseQRPayload(url).metadata).toEqual({ url: 'https://example.com:8443/a:b' });
  });

  test('retains reserved JavaScript property names as ordinary QR metadata keys', () => {
    const url = 'pocketpay://pay?address=GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H&amount=1&metadata=__proto__%3Aa%2Cconstructor%3Ab%2CtoString%3Ac';
    const metadata = parseQRPayload(url).metadata;
    expect(metadata).toBeDefined();
    expect(Object.getPrototypeOf(metadata)).toBeNull();
    expect(Object.keys(metadata!)).toEqual(['__proto__', 'constructor', 'toString']);
    expect(metadata!['__proto__']).toBe('a');
    expect(metadata!['constructor']).toBe('b');
    expect(metadata!['toString']).toBe('c');
    expect(JSON.parse(JSON.stringify(metadata))).toEqual({
      ['__proto__']: 'a', constructor: 'b', toString: 'c',
    });
  });

  test('throws on malformed URL', () => {
    const badUrl = 'pocketpay://pay?address=invalid&amount=abc';
    expect(() => parseQRPayload(badUrl)).toThrow(PaymentParseError);
  });
});
