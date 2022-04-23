import { Range } from "@codemirror/rangeset";
import { EditorView, Decoration } from "@codemirror/view";
import { SelectionRange, EditorSelection, ChangeSpec, ChangeSet } from "@codemirror/state";
import { setCursor, setSelections, findMatchingBracket, resetCursorBlink } from "./editor_helpers";
import { addMark, clearMarks, markerStateField, removeMarkBySpecAttribute, startSnippet, endSnippet } from "./marker_state_field";

const COLORS = ["lightskyblue", "orange", "lime", "pink", "cornsilk", "magenta", "navajowhite"];


export class TabstopReference {
    view: EditorView
    colorIndex: number

    constructor(view: EditorView, colorIndex: number) {
        this.view = view;
        this.colorIndex = colorIndex;
    }

    getColorIndex():number {
        return this.colorIndex;
    }


    get markers(): Range<Decoration>[] {
        const state = this.view.state;
        const iter = state.field(markerStateField).iter();

        const markers = [];

        while (iter.value) {
            if (iter.value.spec.reference === this) {
                markers.push({
                    from: iter.from,
                    to: iter.to,
                    value: iter.value
                });
            }

            iter.next();
        }

        return markers;
    }


    get ranges(): SelectionRange[] {
        const state = this.view.state;
        const iter = state.field(markerStateField).iter();

        const ranges = [];

        while (iter.value) {
            if (iter.value.spec.reference === this) {

                ranges.push(EditorSelection.range(iter.from, iter.to));

            }

            iter.next();
        }

        return ranges;
    }


    removeFromEditor(): void {
        this.view.dispatch({
            effects: removeMarkBySpecAttribute.of({attribute: "reference", reference: this}),
        });
    }
}


export interface Tabstop {
    number: number,
    from: number,
    to: number,
    replacement: string
}


export class SnippetManager {
    private currentTabstopReferences: TabstopReference[] = [];
    private snippetsToAdd: {from: number, to: number, insert: string}[] = [];


    getColorIndex():number {
        let colorIndex = 0;
        for (; colorIndex < COLORS.length; colorIndex++) {
            if (!this.currentTabstopReferences.find(p => p.getColorIndex() === colorIndex))
                break;
        }

        if (colorIndex === COLORS.length) {
            colorIndex = Math.floor(Math.random() * COLORS.length);
        }

        return colorIndex;
    }


    getColorClass(colorIndex: number):string {
        const prefix = "latex-suite-suggestion-placeholder";
        const markerClass = prefix + " " + prefix + colorIndex;

        return markerClass;
    }



    getTabstopsFromSnippet(view: EditorView, start: number, replacement:string):Tabstop[] {

        const tabstops:Tabstop[] = [];
        const text = view.state.doc.toString();


        for (let i = start; i < start + replacement.length; i++) {

            if (!(text.charAt(i) === "$")) {
                continue;
            }

            let number:number = parseInt(text.charAt(i + 1));

            const tabstopStart = i;
            let tabstopEnd = tabstopStart + 2;
            let tabstopReplacement = "";


            if (isNaN(number)) {
                // Check for selection tabstops of the form ${0:XXX}
                if (!(text.charAt(i+1) === "{" && text.charAt(i+3) === ":")) continue;

                number = parseInt(text.charAt(i + 2));
                if (isNaN(number)) continue;


                // Find the matching }
                const closingIndex = findMatchingBracket(text, i+1, "{", "}", false, start + replacement.length);

                if (closingIndex === -1) continue;


                tabstopReplacement = text.slice(i + 4, closingIndex);
                tabstopEnd = closingIndex + 1;
                i = closingIndex;
            }


            // Replace the tabstop indicator "$X" with ""
            const tabstop:Tabstop = {number: number, from: tabstopStart, to: tabstopEnd, replacement: tabstopReplacement};


            tabstops.push(tabstop);
        }


        return tabstops;
    }



    queueSnippet(snippet: {from: number, to: number, insert: string}) {
        this.snippetsToAdd.push(snippet);
    }


    expandSnippets(view: EditorView):boolean {
        if (this.snippetsToAdd.length === 0) return false;

        const snippets = this.snippetsToAdd;
        const changes = snippets as ChangeSpec;

        // Insert the replacements
        view.dispatch({
            changes: changes,
            effects: startSnippet.of(null)
        });


        // Insert any tabstops
        // Find the positions of the cursors in the new document
        const changeSet = ChangeSet.of(changes, view.state.doc.length);
        const oldPositions = snippets.map(change => change.from);
        const newPositions = oldPositions.map(pos => changeSet.mapPos(pos));

        let tabstopsToAdd:Tabstop[] = [];
        for (let i = 0; i < snippets.length; i++) {
            tabstopsToAdd = tabstopsToAdd.concat(this.getTabstopsFromSnippet(view, newPositions[i], snippets[i].insert));
        }

        if (tabstopsToAdd.length === 0) {
            this.snippetsToAdd = [];
            return true;
        }

        this.insertTabstopReferences(view, tabstopsToAdd);
        this.insertTabstopsTransaction(view, tabstopsToAdd);

        this.snippetsToAdd = [];
        return true;
    }



    insertTabstopReferences(view: EditorView, tabstops: Tabstop[], append=false) {

        // Find unique tabstop numbers
        const numbers = Array.from(new Set(tabstops.map((tabstop: Tabstop) => (tabstop.number)))).sort().reverse();


        if (!append) {
            // Create a reference for each tabstop number
            // and add it to the list of current references
            const colorIndex = this.getColorIndex();

            for (let i = 0; i < numbers.length; i++) {
                const reference = new TabstopReference(view, colorIndex);

                this.currentTabstopReferences.unshift(reference);
            }
        }
    }


    insertTabstopsTransaction(view: EditorView, tabstops: Tabstop[]) {

        // Add the markers
        const effects = tabstops.map((tabstop: Tabstop) => {
            const reference = this.currentTabstopReferences[tabstop.number];

            const mark = Decoration.mark({
                    inclusive: true,
                    attributes: {},
                    class: this.getColorClass(reference.colorIndex),
                    reference: reference
            }).range(tabstop.from, tabstop.to);

            return addMark.of(mark);
        });


        view.dispatch({
            effects: effects
        });


        // Insert the replacements
        const changes = tabstops.map((tabstop: Tabstop) => {
            return {from: tabstop.from, to: tabstop.to, insert: tabstop.replacement}
        });

        view.dispatch({
            changes: changes
        });


        // Select the first tabstop
        const selection = EditorSelection.create(this.currentTabstopReferences[0].ranges);

        view.dispatch({
            selection: selection,
            effects: endSnippet.of(null)
        });

        resetCursorBlink();
        this.removeOnlyTabstop();
    }



    selectTabstopReference(reference: TabstopReference) {
        // Select all ranges
        setSelections(reference.view, reference.ranges);

        this.removeOnlyTabstop();
    }

    removeOnlyTabstop() {
        // Remove all tabstop references if there's just one containing zero width tabstops
        if (this.currentTabstopReferences.length === 1) {
            let shouldClear = true;

            const reference = this.currentTabstopReferences[0];
            const markers = reference.markers;

            for (const marker of markers) {
                if (!(marker.from === marker.to)) {
                    shouldClear = false;
                    break;
                }
            }

            if (shouldClear) this.clearAllTabstops(reference.view);
        }
    }


    isInsideATabstop(pos: number):boolean {
        if (this.currentTabstopReferences.length === 0) return false;

        let isInside = false;

        for (const tabstopReference of this.currentTabstopReferences) {
            for (const range of tabstopReference.ranges) {
                if ((pos >= range.from) && (pos <= range.to)) {
                    isInside = true;
                    break;
                }
            }

            if (isInside) break;
        }

        return isInside;
    }



    consumeAndGotoNextTabstop(view: EditorView): boolean {
        // Check whether there are currently any tabstops
        if (this.currentTabstopReferences.length === 0) return false;


        const oldCursor = view.state.selection.main;


        // Remove the tabstop that we're inside of
        const oldTabstop = this.currentTabstopReferences.shift();
        const oldMarkers = oldTabstop.markers;
        oldTabstop.removeFromEditor();


        // If there are none left, return
        if (this.currentTabstopReferences.length === 0) {
            setCursor(view, oldCursor.to);

            return true;
        }


        // Select the next tabstop
        const newTabstop = this.currentTabstopReferences[0];
        const newMarkers = newTabstop.markers;

        const oldMarker = oldMarkers[0];
        const newMarker = newMarkers[0];

        // If the new tabstop has a single cursor, and
        // the old tabstop is inside of the new one, we just move the cursor
        if (newTabstop.markers.length === 1) {
            if (newMarker.from <= oldMarker.from && newMarker.to >= oldMarker.to) {
                setCursor(view, newMarker.to)
            }
            else {
                this.selectTabstopReference(newTabstop);


                // Otherwise, if the new tabstop was positioned at the end of its snippet
                // i.e. it has 0 width and is aligned with the end of the next tabstop reference
                // Make it the same color as the next tabstop reference

                if (this.currentTabstopReferences.length > 1) {
                    const nextTabstopRef = this.currentTabstopReferences[1];
                    const ranges = nextTabstopRef.ranges;
                    const lastRange = ranges[ranges.length - 1];

                    if (newMarker.from === newMarker. to && newMarker.to === lastRange.to) {

                        const colorIndex = nextTabstopRef.colorIndex;

                        newTabstop.colorIndex = colorIndex;
                        newMarker.value.spec.attributes.class = this.getColorClass(colorIndex);
                    }
                }
            }
        }
        else {
            this.selectTabstopReference(newTabstop);
        }



        // If we haven't moved, go again
        const newCursor = view.state.selection.main;

        if (oldCursor.eq(newCursor))
            return this.consumeAndGotoNextTabstop(view);


        return true;
    }


    tidyTabstopReferences() {
        // Remove empty tabstop references
        this.currentTabstopReferences = this.currentTabstopReferences.filter(tabstopReference => tabstopReference.markers.length > 0);
    }



    clearAllTabstops(view?: EditorView) {
        if (view) {
            view.dispatch({
                effects: clearMarks.of(null)
            });
        }

        this.currentTabstopReferences = [];
    }


    onunload() {
        this.clearAllTabstops();
    }

}