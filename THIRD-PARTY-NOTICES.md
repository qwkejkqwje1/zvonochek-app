# Сторонние компоненты (THIRD-PARTY-NOTICES)

ZVONochek для ПК © ZVONochek. Все права защищены.

В программу входят сторонние компоненты с открытыми лицензиями; ниже — их список и тексты лицензий. Microsoft Edge WebView2 Runtime не входит в состав программы: он устанавливается из Windows или загрузчиком Microsoft по условиям Microsoft.

Всего компонентов: 2.

## Компоненты

- **QR Code Generator for JavaScript (qrcode.js)** — MIT — https://github.com/kazuhikoarase/qrcode-generator — тексты: [1](#t1)
- **noble-secp256k1** — MIT — https://github.com/paulmillr/noble-secp256k1 — тексты: [2](#t2)

## Тексты лицензий

<a id="t1"></a>
### [1] LICENSE — QR Code Generator for JavaScript (qrcode.js)

```
Copyright (c) 2009 Kazuhiko Arase

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

— шапка файла:
//---------------------------------------------------------------------
//
// QR Code Generator for JavaScript
//
// Copyright (c) 2009 Kazuhiko Arase
//
// URL: http://www.d-project.com/
//
// Licensed under the MIT license:
//  http://www.opensource.org/licenses/mit-license.php
//
// The word 'QR Code' is registered trademark of
// DENSO WAVE INCORPORATED
//  http://www.denso-wave.com/qrcode/faqpatent-e.html
//
//---------------------------------------------------------------------
```

<a id="t2"></a>
### [2] LICENSE — noble-secp256k1

```
Copyright (c) 2019 Paul Miller (https://paulmillr.com)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

— шапка файла:
/*! noble-secp256k1 - MIT License (c) 2019 Paul Miller (paulmillr.com) */
/**
 * 5KB JS implementation of secp256k1 ECDSA / Schnorr signatures & ECDH.
 * Compliant with RFC6979 & BIP340.
 * @module
 */
/**
 * Curve params from SEC 2 v2 §2.4.1.
 * secp256k1 is a short Weierstrass / Koblitz curve with equation
 * `y² == x³ + ax + b`.
 * * P = `2n**256n - 2n**32n - 977n` // field over which calculations are done
 * * N = `2n**256n - 0x14551231950b75fc4402da1732fc9bebfn` // group order, amount of curve points
 * * h = `1n` // cofactor
 * * a = `0n` // equation param
 * * b = `7n` // equation param
 * * Gx, Gy are coordinates of Generator / base point
 */
```

