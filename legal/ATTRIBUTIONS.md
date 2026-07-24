# Third-Party Attributions

This project incorporates code and components from the following open-source projects:

## agmmnn/tauri-ui

**License**: MIT
**Copyright**: Copyright (c) 2024 Αγa Μ. Μ.
**Repository**: https://github.com/agmmnn/tauri-ui

### Components Used:
- `src/components/ui/tabs.tsx` - Radix UI Tabs wrapper
- `src/components/ui/accordion.tsx` - Radix UI Accordion wrapper
- `src/components/ui/menubar.tsx` - Radix UI Menubar wrapper

### Inspiration:
- Navigation pattern for hierarchical test categories in `StatisticalTestsNav.tsx`
- Tailwind scrollbar styling configuration

### MIT License Text:

```
MIT License

Copyright (c) 2024 Αγa Μ. Μ.

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

## dannysmith/tauri-template

**License**: MIT
**Copyright**: Copyright © 2025 Danny Smith. All rights reserved.
**Repository**: https://github.com/dannysmith/tauri-template

### Foundation:
This project is built on top of dannysmith/tauri-template, which provides:
- React 19 + Vite + TypeScript setup
- Tailwind CSS 4 configuration
- Tauri 2.0 integration
- Resizable panel layout system
- Command palette component
- Theme provider with persistent preferences
- Comprehensive shadcn/ui component library
- Testing setup (Vitest, Testing Library)

### MIT License Text:

```
MIT License

Copyright (c) 2025 Danny Smith

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

## shadcn/ui

**License**: MIT
**Repository**: https://ui.shadcn.com/

All components in `src/components/ui/` are based on shadcn/ui, which provides
accessible, unstyled components built on Radix UI primitives.

---

## slaylines/sparkle-icons

**License**: MIT
**Repository**: https://github.com/slaylines/sparkle-icons

### Icons Used:
- `src/components/icons/BoxPlotIcon.tsx` - Box plot visualization icon
- `src/components/icons/GroupedBarIcon.tsx` - Grouped bar chart visualization icon
- `src/components/icons/LinePlotIcon.tsx` - Line chart visualization icon
- `src/components/icons/StackedBarPlotIcon.tsx` - Stacked bar chart visualization icon

### MIT License Text:

```
MIT License

Copyright (c) 2024 slaylines

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

## Pictogrammers / Material Design Icons

**License**: Apache License 2.0
**Designer**: Pictogrammers Team
**Repository**: https://github.com/Templarian/MaterialDesign
**Website**: https://pictogrammers.com/library/mdi/

### Icons Used:
- `src/components/icons/TablePivotIcon.tsx` - Table pivot icon for data transformation operations
  - Source: https://www.iconarchive.com/show/material-icons-by-pictogrammers/table-pivot-icon.html
  - Icon ID: `mdi-table-pivot`

### Apache License 2.0 Summary:

The Apache License 2.0 allows:
- ✅ Commercial use
- ✅ Modification
- ✅ Distribution
- ✅ Patent use
- ✅ Private use

**Full License Text**: https://www.apache.org/licenses/LICENSE-2.0

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   [... abbreviated for brevity - full license available at apache.org ...]
```

---

## Other Dependencies

See `package.json` and `src-tauri/Cargo.toml` for complete dependency listings
and their respective licenses.
