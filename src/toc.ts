'use strict';

import * as vscode from 'vscode';
import { extractText, isMdEditor, mdDocSelector, slugify } from './util';
import * as stringSimilarity from 'string-similarity';

/**
 * Workspace config
 */
const docConfig = { tab: '  ', eol: '\r\n' };
const tocConfig = { startDepth: 1, endDepth: 6, listMarker: '-', orderedList: false, updateOnSave: false, plaintext: false, tabSize: 2 };

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('mdx.extension.toc.create', createToc),
        vscode.commands.registerCommand('mdx.extension.toc.update', updateToc),
        vscode.workspace.onWillSaveTextDocument(onWillSave),
        vscode.languages.registerCodeLensProvider(mdDocSelector, new TocCodeLensProvider())
    );
}

async function createToc() {
    let editor = vscode.window.activeTextEditor;

    if (!isMdEditor(editor)) {
        return;
    }

    let toc = await generateTocText(editor.document);
    await editor.edit(function (editBuilder) {
        editBuilder.delete(editor.selection);
        editBuilder.insert(editor.selection.active, toc);
    });
}

async function updateToc() {
    const editor = vscode.window.activeTextEditor;

    if (!isMdEditor(editor)) {
        return;
    }

    const doc = editor.document;
    const tocRangesAndText = await detectTocRanges(doc);
    const tocRanges = tocRangesAndText[0];
    const newToc = tocRangesAndText[1];

    await editor.edit(editBuilder => {
        for (const tocRange of tocRanges) {
            if (tocRange !== null) {
                const oldToc = getText(tocRange).replace(/\r?\n|\r/g, docConfig.eol);
                if (oldToc !== newToc) {
                    const unchangedLength = commonPrefixLength(oldToc, newToc);
                    const newStart = doc.positionAt(doc.offsetAt(tocRange.start) + unchangedLength);
                    const replaceRange = tocRange.with(newStart);
                    if (replaceRange.isEmpty) {
                        editBuilder.insert(replaceRange.start, newToc.substring(unchangedLength));
                    } else {
                        editBuilder.replace(replaceRange, newToc.substring(unchangedLength));
                    }
                }
            }
        }
    });
}

async function generateTocText(doc: vscode.TextDocument): Promise<string> {
    loadTocConfig();
    const orderedListMarkerIsOne: boolean = vscode.workspace.getConfiguration('markdown.extension.orderedList').get<string>('marker') === 'one';

    let toc = [];
    let tocEntries = buildToc(doc);
    if (tocEntries === null || tocEntries === undefined || tocEntries.length < 1) return '';

    let startDepth = Math.max(tocConfig.startDepth, Math.min.apply(null, tocEntries.map(h => h.level)));
    let order = new Array(tocConfig.endDepth - startDepth + 1).fill(0); // Used for ordered list

    let anchorOccurances = {};

    tocEntries.forEach(entry => {
        if (entry.level <= tocConfig.endDepth && entry.level >= startDepth) {
            let relativeLvl = entry.level - startDepth;
            let entryText = extractText(entry.text);
            let anchorText = entryText;

            if (anchorOccurances.hasOwnProperty(anchorText)) {
                anchorOccurances[anchorText] += 1;
                anchorText += ' ' + String(anchorOccurances[anchorText]);
            } else {
                anchorOccurances[anchorText] = 0;
            }

            let row = [
                docConfig.tab.repeat(relativeLvl),
                (tocConfig.orderedList ? (orderedListMarkerIsOne ? '1' : ++order[relativeLvl]) + '.' : tocConfig.listMarker) + ' ',
                tocConfig.plaintext ? entryText : `[${entryText}](#${slugify(anchorText)})`
            ];
            toc.push(row.join(''));
            if (tocConfig.orderedList) order.fill(0, relativeLvl + 1);
        }
    });
    while (/^[ \t]/.test(toc[0])) {
        toc = toc.slice(1);
    }
    return toc.join(docConfig.eol);
}

/**
 * Returns an array of TOC ranges.
 * If no TOC is found, returns an empty array.
 * @param doc a TextDocument
 */
async function detectTocRanges(doc: vscode.TextDocument): Promise<[Array<vscode.Range>, string]> {
    let tocRanges = [];
    const newTocText = await generateTocText(doc);
    const fullText = doc.getText();
    let listRegex = /(^|\r?\n)((?:[-+*]|[0-9]+[.)]) .*(?:\r?\n[ \t]*(?:[-+*]|[0-9]+[.)]) .*)*)/g;
    let match;
    while ((match = listRegex.exec(fullText)) !== null) {
        //// #525 <!-- no toc --> comment
        const listStartPos = doc.positionAt(match.index + match[1].length);
        if (listStartPos.line > 0 && doc.lineAt(listStartPos.line - 1).text.includes("no toc")) {
            continue;
        }

        const listText = match[2];

        //// Sanity checks
        const firstLine: string = listText.split(/\r?\n/)[0];
        if (vscode.workspace.getConfiguration('markdown.extension.toc').get<boolean>('plaintext')) {
            //// A lazy way to check whether it is a link
            if (firstLine.includes('](')) {
                continue;
            }
        } else {
            //// GitHub issue #304 & #549
            if (!(firstLine.includes('](#') && firstLine.trim().split(' ')[1].startsWith('['))) {
                continue;
            }
        }

        if (radioOfCommonPrefix(newTocText, listText) + stringSimilarity.compareTwoStrings(newTocText, listText) > 0.5) {
            tocRanges.push(
                new vscode.Range(listStartPos, doc.positionAt(listRegex.lastIndex))
            );
        }
    }

    return [tocRanges, newTocText];
}

function commonPrefixLength(s1, s2) {
    let minLength = Math.min(s1.length, s2.length);
    for (let i = 0; i < minLength; i++) {
        if (s1[i] !== s2[i]) {
            return i;
        }
    }
    return minLength;
}

function radioOfCommonPrefix(s1, s2) {
    let minLength = Math.min(s1.length, s2.length);
    let maxLength = Math.max(s1.length, s2.length);

    let prefixLength = commonPrefixLength(s1, s2);
    if (prefixLength < minLength) {
        return prefixLength / minLength;
    } else {
        return minLength / maxLength;
    }
}

function onWillSave(e: vscode.TextDocumentWillSaveEvent) {
    if (!tocConfig.updateOnSave) return;
    if (e.document.languageId == 'markdown') {
        e.waitUntil(updateToc());
    }
}

function loadTocConfig() {
    let tocSectionCfg = vscode.workspace.getConfiguration('markdown.extension.toc');
    let tocLevels = tocSectionCfg.get<string>('levels');
    let matches;
    if (matches = tocLevels.match(/^([1-6])\.\.([1-6])$/)) {
        tocConfig.startDepth = Number(matches[1]);
        tocConfig.endDepth = Number(matches[2]);
    }
    tocConfig.orderedList = tocSectionCfg.get<boolean>('orderedList');
    tocConfig.listMarker = tocSectionCfg.get<string>('unorderedList.marker');
    tocConfig.plaintext = tocSectionCfg.get<boolean>('plaintext');
    tocConfig.updateOnSave = tocSectionCfg.get<boolean>('updateOnSave');

    // Load workspace config
    let activeEditor = vscode.window.activeTextEditor;
    docConfig.eol = activeEditor.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';

    let tabSize = Number(activeEditor.options.tabSize);
    if (vscode.workspace.getConfiguration('markdown.extension.list', activeEditor.document.uri).get<string>('indentationSize') === 'adaptive') {
        tabSize = tocConfig.orderedList ? 3 : 2;
    }

    let insertSpaces = activeEditor.options.insertSpaces;
    if (insertSpaces) {
        docConfig.tab = ' '.repeat(tabSize);
    } else {
        docConfig.tab = '\t';
    }
}

function getText(range: vscode.Range): string {
    return vscode.window.activeTextEditor.document.getText(range);
}

export function buildToc(doc: vscode.TextDocument) {
    let toc;
    let lines = doc.getText()
        .replace(/^ {0,3}```[\W\w]+?^ {0,3}```/gm, '')  //// Remove code blocks
        .replace(/<!-- omit in (toc|TOC) -->/g, '&lt; omit in toc &gt;')  //// Escape magic comment
        .replace(/<!--[\W\w]+?-->/, '')                 //// Remove comments
        .replace(/^---[\W\w]+?(\r?\n)---/, '')          //// Remove YAML front matter
        .split(/\r?\n/g);
    lines.forEach((lineText, i, arr) => {
        //// Transform setext headings to ATX headings
        if (
            i < arr.length - 1
            && lineText.match(/^ {0,3}\S.*$/)
            && arr[i + 1].match(/^ {0,3}(=+|-{2,}) *$/)
        ) {
            arr[i] = (arr[i + 1].includes('=') ? '# ' : '## ') + lineText;
        }
        //// Ignore headings following `<!-- omit in toc -->`
        if (
            i > 0
            && arr[i - 1] === '&lt; omit in toc &gt;'
        ) {
            arr[i] = '';
        }
    });
    toc = lines.filter(lineText => {
        return lineText.trim().startsWith('#')
            && !lineText.startsWith('    ')  //// The opening `#` character may be indented 0-3 spaces
            && lineText.includes('# ')
            && !lineText.includes('&lt; omit in toc &gt;');
    }).map(lineText => {
        lineText = lineText.replace(/^ +/, '');
        let entry = {};
        let matches = /^(#+) (.*)/.exec(lineText);
        entry['level'] = matches[1].length;
        entry['text'] = matches[2].replace(/#+$/, '').trim();
        return entry;
    });

    return toc;
}

class TocCodeLensProvider implements vscode.CodeLensProvider {
    public provideCodeLenses(document: vscode.TextDocument, _: vscode.CancellationToken):
        vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
        let lenses: vscode.CodeLens[] = [];
        return detectTocRanges(document).then(tocRangesAndText => {
            const tocRanges = tocRangesAndText[0];
            const newToc = tocRangesAndText[1];
            for (let tocRange of tocRanges) {
                let status = getText(tocRange).replace(/\r?\n|\r/g, docConfig.eol) === newToc ? 'up to date' : 'out of date';
                lenses.push(new vscode.CodeLens(tocRange, {
                    arguments: [],
                    title: `Table of Contents (${status})`,
                    command: ''
                }));
            }
            return lenses;
        });
    }
}
