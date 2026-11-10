# 第三方组件与许可

Solo 分发的二进制里含有下列第三方代码。这里保留各自要求的版权声明与协议原文。

> **维护方式**：新增或升级运行时依赖时，先读它的 `package.json` 的 `license` 字段与包内
> `LICENSE` 文件，再更新本文。**别凭包名猜协议。**
> 核对入口：`npm ls --omit=dev --all` 与 `node_modules/<name>/package.json`。

## 一览

| 组件 | 版本 | 协议 | 用在哪 | 声明要求 |
|---|---|---|---|---|
| `sherpa-onnx-node` | 2.0.1 | Apache-2.0 | 本机语音的 JS 包装层（无二进制） | 附协议全文 + 保留版权 + 标注改动 |
| `sherpa-onnx-darwin-arm64` 等平台包 | 2.0.1 | Apache-2.0 | 真正的原生二进制：`sherpa-onnx.node` 与 `libsherpa-onnx-*.dylib` | 同上 |
| `libonnxruntime.dylib`（随平台包分发） | 随包 | MIT | 推理引擎，被上面两个 dylib 动态链接 | 保留版权与许可声明 |
| `@dicebear/core` | 9.4.3 | MIT | 生成头像 | 保留版权与许可声明 |
| `@dicebear/collection` | 9.4.2 | MIT | 头像素材集 | 保留版权与许可声明 |
| `@earendil-works/chord` | 1.5.0 | MIT | 模型调用编排 | 保留版权与许可声明 |
| `@earendil-works/pi-ai` | 1.5.0 | MIT | 模型供应商接入 | 保留版权与许可声明 |
| `@earendil-works/pi-durable` | 1.5.0 | MIT | 持久化 | 保留版权与许可声明 |
| `@earendil-works/pi-schema` | 1.5.0 | MIT | 结构化输出 | 保留版权与许可声明 |
| `@ennuicastr/webrtcaec3.js` | 0.3.0 | BSD-3-Clause 等 | 回声消除（**尚未接入**） | 见文件末尾 |

> `@ennuicastr/webrtcaec3.js` 目前**没有进包**。老板点头接 AEC 之后再装依赖、把它的四段声明
> 与本文件合并。它需要的原文已备在 `teams/Solo/workspace/aec3/第三方声明.md`。

---

## 打包版的合规判断（2026-11-10 核过）

**问题**：我们发的是打包版，`sherpa-onnx-node` 要求附 Apache-2.0 全文——附了全文就够吗？

**结论：够。** 依据与核实过程：

1. **Apache-2.0 第 4 条要的三件事**：(a) 给接收者一份许可副本；(b) 改过的文件要显著标注；(c) 保留原来源的所有版权、专利、商标与署名声明。
   我们：(a) 本文即副本，随包分发；(b) 未修改其源码，无需改标；(c) 原文照留。
   第 4(d) 条另有「若作品含 NOTICE 文件则须一并转载」——**核过：这两个包都没有 NOTICE 文件**（`ls` 查过），故无附加义务。

2. **「要不要在可执行文件里带声明」**：不要。Apache-2.0 要求的是「随分发物能让接收者看到」，不要求嵌进二进制。
   而且本项目 `asar: false`（`electron-builder.yml` 第 56 行），`Contents/Resources/app/` 是摊开的普通目录，
   `seed/legal/THIRD-PARTY.md` 就在里面，**用 Finder 就能翻到**——这一点比打进 asar 还容易查看。

3. **但原来那份写法不够，已补的**：`sherpa-onnx-node` 只是 JS 包装层，**没有任何二进制**。
   真正的二进制在按平台拉的 `sherpa-onnx-darwin-arm64` 里：
   `sherpa-onnx.node`、`libsherpa-onnx-c-api.dylib`、`libsherpa-onnx-cxx-api.dylib`，
   以及 **`libonnxruntime.dylib`（29MB，微软 MIT 许可，独立一家）**。
   已核实这些 dylib **确实进了 `/Applications/Solo.app`**（`find` 查到三个 `.dylib`）。
   onnxruntime 是 MIT，与 sherpa-onnx 的 Apache-2.0 不同，**必须单独署名**，已在下方附原文。

4. **实查：这些 .dylib 里没有内嵌任何许可文本**（`strings` 搜 apache/license/copyright 均无结果）。
   所以声明**只能靠这份文档**，不能指望二进制自带——这也是「必须写清楚」的实际理由。

**还差的（要人拍的）**：应用内目前没有「关于 / 第三方声明」的入口。
文件在包里、看得见，但用户不会去翻 `Resources/app/`。**要不要在界面里加一个能打开的入口**，这条我不自己定。

---

## Apache License 2.0（`sherpa-onnx-node`）

`node_modules/sherpa-onnx-node` 的 `package.json` 声明 `"license": "Apache-2.0"`，
来源 <https://github.com/csukuangfj/sherpa-onnx>。该包**未随附 LICENSE 文件**，故按 Apache-2.0
正文第 4 条在此附上完整协议。Solo 未修改其源码。

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS
```

---

## MIT License（`@dicebear/core`、`@dicebear/collection`）

`@dicebear/*` 包内随附 `LICENSE`，原文如下（两包相同，来源 <https://github.com/dicebear/dicebear>）：

```
MIT License

Copyright (c) 2024 Florian Körner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## MIT License（`@earendil-works/chord`、`pi-ai`、`pi-durable`、`pi-schema`）

这四个包的 `package.json` 声明 `"license": "MIT"`，来源 <https://github.com/earendil-works/pi>。
包内**未随附 LICENSE 文件**，故在此附上 MIT 正文。版权归 earendil-works。

```
MIT License

Copyright (c) earendil-works

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## MIT License（`libonnxruntime.dylib` / ONNX Runtime）

随 `sherpa-onnx-darwin-arm64` 一起分发的推理引擎，来源 <https://github.com/microsoft/onnxruntime>。
该 dylib 内未内嵌许可文本，故在此附上原文。

```
MIT License

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 待接入：`@ennuicastr/webrtcaec3.js` 0.3.0

**未进包。** 接入时把下列四段原文并入本文件（完整内容见 `teams/Solo/workspace/aec3/第三方声明.md`）：

- **WebRTC** — BSD-3-Clause，`Copyright (c) 2011-2022 The WebRTC project authors`，并须一并附上 Google 的附加专利授权全文。
- **abseil-cpp** — Apache-2.0，`Copyright 2017-2023 The Abseil Authors`（正文同上，不必重复）。
- **Emscripten / musl** — MIT，`Copyright (c) 2010-2023 Emscripten authors`、`Copyright © 2005-2023 Rich Felker, et al.`

该包自带的胶水代码是 0-clause BSD（不要求署名）。
