// The Learn area's curriculum: what each lesson says, and the positions it practises on.
import { boxes } from "../core/geometry.ts";
import { type Drill, drillOf } from "./drill.ts";
import { POSITIONS as STANDARD_POSITIONS, PUZZLES as STANDARD_PUZZLES } from "./positions.ts";
import { type PositionData, type PuzzleData, dataLayout, decodeCand, positionState } from "./positions-format.ts";
import { type State, type Step, apply, parseGrid } from "./state.ts";
import { techniqueById } from "./techniques.ts";
import { VARIANT_POSITIONS, VARIANT_PUZZLES } from "./variant-positions.ts";

/** Every lesson's practice positions by technique id: standard Sudoku's, then the variants'. */
export const POSITIONS: Record<string, readonly PositionData[]> = { ...STANDARD_POSITIONS, ...VARIANT_POSITIONS };
/** Every lesson's whole puzzle by technique id. */
export const PUZZLES: Record<string, PuzzleData> = { ...STANDARD_PUZZLES, ...VARIANT_PUZZLES };

export interface Lesson {
  /** The technique's id, or `notes` for the lesson on candidates. */
  id: string;
  title: string;
  /** The technique it teaches, or `null` for the notes lesson. */
  technique: string | null;
  /** One line for the lesson list. */
  summary: string;
  /** The explanation, a paragraph each. */
  intro: string[];
  /** How to spot it in a real puzzle. */
  spot: string[];
}

/** The lessons of one difficulty, named as the Graded puzzles name it. */
export interface Level {
  name: string;
  blurb: string;
  lessons: Lesson[];
}

const lesson = (id: string, title: string, summary: string, intro: string[], spot: string[]): Lesson =>
  ({ id, title, technique: id === "notes" ? null : id, summary, intro, spot });

export const LEVELS: readonly Level[] = [
  {
    name: "Easy",
    blurb: "The rules, and finding the one place a digit can go. No notes needed.",
    lessons: [
      lesson("fullHouse", "The rules and the last square",
        "Every row, column and box holds 1 to 9 once. Start with a unit that has one gap.",
        [
          "A sudoku has 9 rows, 9 columns and 9 boxes of 3 by 3. Each of those 27 units must hold every digit from 1 to 9 exactly once. That is the only rule, and every technique here follows from it.",
          "Squares are named by row and column: R3C5 is row 3 (from the top), column 5 (from the left). Boxes are numbered 1 to 9, left to right, top to bottom.",
          "The simplest step is the full house: a row, column or box with eight digits filled in. The ninth can only be the digit that is missing.",
          "A good puzzle never needs a guess. Every digit you place should be one you can prove, and these lessons show you how.",
        ],
        [
          "Look for a row, column or box that is nearly full.",
          "Count 1 to 9 along it to find the digit that is missing.",
        ]),
      lesson("crossHatch", "Cross-hatching",
        "Pick a digit and a box. Rows and columns that already hold the digit cross squares out.",
        [
          "Pick one digit, say 7, and one box that has no 7 yet. Every 7 already on the board rules out its whole row and its whole column.",
          "Draw those rows and columns across the box in your head. If they cross out every empty square of the box but one, the 7 goes in the square that is left.",
          "This is called cross-hatching, or scanning. It is the fastest way to start most puzzles, because you need no notes at all.",
        ],
        [
          "Work through the digits 1 to 9. Digits that are already on the board many times are the easiest to place.",
          "For each digit, look at the boxes that don't have it yet, and at the rows and columns that do.",
        ]),
      lesson("hiddenSingle", "Hidden singles in rows and columns",
        "The same idea along a line: a digit with one place left in a row or column.",
        [
          "Cross-hatching asks where a digit can go in a box. You can ask the same about a row or a column.",
          "Take a row and a digit it is missing. Some empty squares are ruled out because their column already holds the digit, and some because their box does. If only one square is left, the digit goes there.",
          "It is called a hidden single because the square itself might allow several digits: the single is hidden among them. What matters is that the digit has nowhere else to go in the unit.",
        ],
        [
          "Rows and columns with only three or four gaps are the best places to look.",
          "For each missing digit, check each gap's column (or row) and box for that digit.",
        ]),
    ],
  },
  {
    name: "Medium",
    blurb: "Looking at one square and asking what can still go in it. This is where notes begin.",
    lessons: [
      lesson("notes", "Notes and candidates",
        "Write down what each square can still be. Every harder technique works on these notes.",
        [
          "A candidate is a digit that could still go in a square: one that is not already in the square's row, column or box.",
          "Writing candidates as small digits in the square is called making notes, or pencil marks. In a game, turn on Notes (or press N) and tap digits to add or remove them.",
          "From here on, solving is mostly about removing candidates. Each technique proves that some candidate is impossible. When a square has one candidate left, or a digit has one place left in a unit, you can place it.",
          "In the practice below, fill in the notes for the highlighted squares.",
        ],
        [
          "For each square, run through 1 to 9 and leave out anything already in its row, column or box.",
          "Keep notes up to date: when you place a digit, remove it from the notes of every square that sees it.",
        ]),
      lesson("nakedSingle", "Naked singles",
        "A square whose row, column and box already hold eight different digits.",
        [
          "Look at one empty square and collect every digit in its row, its column and its box. If eight different digits turn up, the square must be the ninth.",
          "With notes, a naked single is easy to see: it is a square with one candidate left. Without notes it is harder to spot than a hidden single, because you have to look at three units at once.",
          "In the practice you can turn Candidates on to see every square's notes, or leave them off for a harder test.",
        ],
        [
          "Look at squares where a busy row, a busy column and a busy box meet.",
          "With notes on, look for a square holding a single small digit.",
        ]),
    ],
  },
  {
    name: "Hard",
    blurb: "Working with notes: a digit locked into a line or box, and groups of squares that share digits.",
    lessons: [
      lesson("pointing", "Pointing",
        "In a box, a digit's places all sit on one line: it leaves the rest of that line.",
        [
          "Look at one box and one digit. Suppose every place the digit can go in that box lies in the same row.",
          "The box needs that digit, so it will end up in one of those squares, and therefore in that row. Nothing else in the row, outside the box, can be that digit.",
          "The same works when the places line up in a column. The squares point along the line, which gives the technique its name. It places nothing itself, but the candidates it removes often reveal a single.",
        ],
        [
          "In each box, look for a digit with only two or three places, all in a line.",
          "Then follow the line out of the box and remove the digit from the rest of it.",
        ]),
      lesson("claiming", "Claiming",
        "In a row or column, a digit's places all sit in one box: it leaves the rest of that box.",
        [
          "Claiming is pointing turned around. Look at one row (or column) and one digit. Suppose every place the digit can go in that row lies inside the same box.",
          "The row needs the digit, so it will be in one of those squares, and therefore in that box. The other squares of the box can't hold it.",
          "Pointing and claiming together are also called locked candidates or box-line reduction.",
        ],
        [
          "In each row and column, look for a digit whose places all fall in one box.",
          "Then remove the digit from the box's other squares.",
        ]),
      lesson("nakedPair", "Naked pairs",
        "Two squares in a unit with the same two candidates use up both digits.",
        [
          "Suppose two squares in the same row both have exactly the candidates 3 and 7. One of them will be 3 and the other 7. You don't know which yet, but both digits are spoken for.",
          "So no other square in that row can be 3 or 7, and you can remove those candidates from the rest of the row.",
          "It works in a row, a column or a box. If the two squares share both a box and a line, it works in both.",
        ],
        [
          "Look for squares with exactly two candidates, then for a twin in the same row, column or box.",
          "Remove both digits from every other square of the unit they share.",
        ]),
      lesson("hiddenPair", "Hidden pairs",
        "Two digits that fit in only the same two squares of a unit push everything else out.",
        [
          "Suppose that in one row, the digits 2 and 8 can each go in only two squares, and they are the same two squares.",
          "Those two squares must hold the 2 and the 8 between them, so they have no room for anything else. Every other candidate can be removed from the two squares.",
          "It is the mirror image of a naked pair. The pair is hidden because the squares have other candidates too. After the removals, it becomes a naked pair.",
        ],
        [
          "In a unit, count where each missing digit can go. Look for two digits with the same two places.",
          "Clear every other candidate out of those two squares.",
        ]),
      lesson("nakedTriple", "Naked triples",
        "Three squares in a unit that hold only three digits between them.",
        [
          "Three squares in one unit whose candidates, taken together, are just three digits must hold those three digits. No other square of the unit can have them.",
          "The squares don't each need all three digits. Candidates of 1 2, 2 3 and 1 3 make a naked triple just as well as 1 2 3 three times.",
        ],
        [
          "Look for three squares in a unit with two or three candidates each, drawn from the same three digits.",
          "Remove those three digits from the rest of the unit.",
        ]),
      lesson("hiddenTriple", "Hidden triples",
        "Three digits that fit in only the same three squares of a unit.",
        [
          "If three digits can only go in the same three squares of a unit, those squares must hold exactly those digits. Every other candidate leaves the three squares.",
          "As with naked triples, each digit doesn't need to be in all three squares. What matters is that the three digits have no other place in the unit.",
        ],
        [
          "In a unit with many gaps, look for three digits that each have only two or three places.",
          "If those places add up to three squares, clear everything else out of them.",
        ]),
      lesson("nakedQuad", "Naked quads",
        "Four squares in a unit that hold only four digits between them.",
        [
          "The same idea, one size up: four squares in a unit whose candidates together are four digits. Those digits leave every other square of the unit.",
          "Quads are rare and hard to see. They show up in units with seven or more empty squares.",
        ],
        [
          "Look in a unit with many gaps for four squares that share a small set of digits.",
          "A naked quad always has a hidden group in the unit's other squares. Look for whichever is smaller.",
        ]),
      lesson("hiddenQuad", "Hidden quads",
        "Four digits that fit in only the same four squares of a unit.",
        [
          "Four digits that can only go in the same four squares of a unit must fill those squares. Every other candidate leaves them.",
          "This is the rarest of the subsets. You can solve for years without needing one, but it completes the family: pairs, triples and quads, each naked or hidden.",
        ],
        [
          "In a unit with eight or nine gaps, look for four digits that all avoid the same squares.",
          "Clear the other candidates out of the four squares they share.",
        ]),
    ],
  },
  {
    name: "Expert",
    blurb: "Patterns that cover several rows and columns at once, and short wings of two-candidate squares.",
    lessons: [
      lesson("xWing", "X-Wing",
        "A digit with the same two places in two rows forms a rectangle, and clears two columns.",
        [
          "Pick one digit. Suppose that in two different rows it can only go in two squares, and those squares are in the same two columns. The four squares are the corners of a rectangle.",
          "Each row needs the digit once. If the top row has it in the left column, the bottom row must have it in the right, and the other way around. Either way, each of the two columns gets its digit from a corner.",
          "So the digit can be removed from every other square of those two columns. It works the same with rows and columns swapped.",
        ],
        [
          "For one digit, look for rows where it has exactly two places.",
          "Find two such rows whose places share the same columns, then clear the rest of both columns.",
        ]),
      lesson("swordfish", "Swordfish",
        "An X-Wing across three rows and three columns.",
        [
          "A swordfish is an X-Wing grown by one. Take a digit and three rows where it has two or three places, and suppose all those places fall in the same three columns.",
          "The three rows need the digit three times, and they can only use those three columns, once each. So the columns get their digit from these rows, and the digit leaves the rest of those columns.",
          "Not every corner of the 3 by 3 grid has to be there. Rows with only two of the three columns still count.",
        ],
        [
          "For one digit, list the rows where it has at most three places.",
          "Look for three of them that use only three columns between them.",
        ]),
      lesson("jellyfish", "Jellyfish",
        "The same fish with four rows and four columns.",
        [
          "A jellyfish is the largest fish worth looking for: four rows where a digit's places all fall in the same four columns (or four columns and four rows). The digit leaves the rest of those four columns.",
          "Jellyfish are rare. The Graded puzzles never need one, but it is good to know how the fish family ends: an X-Wing is 2 by 2, a swordfish 3 by 3, a jellyfish 4 by 4.",
        ],
        [
          "Look for one when a digit has many candidates and no smaller fish.",
          "Every fish has a matching fish in the other lines. A jellyfish in rows often hides a smaller fish in columns.",
        ]),
      lesson("skyscraper", "Skyscraper",
        "Two rows where a digit has two places, lined up at one end only.",
        [
          "Start like an X-Wing: one digit, two rows where it has exactly two places. This time only one pair of ends shares a column. The other two ends, the roofs, are in different columns.",
          "In the shared column only one of the two base squares can be the digit. So at least one row has its digit at the roof end. One of the two roofs is always the digit.",
          "Any square that sees both roofs can't be the digit. It works with columns in place of rows too.",
        ],
        [
          "Look for a near miss of an X-Wing: two lines with two places each, joined at one end.",
          "Then find the squares that see both of the loose ends.",
        ]),
      lesson("twoStringKite", "2-String Kite",
        "A row and a column where a digit has two places, joined through a box.",
        [
          "Take one digit, a row where it has exactly two places and a column where it has exactly two places. Suppose one end of the row and one end of the column are in the same box.",
          "Those two ends can't both be the digit, because they share a box. So at least one of the far ends is the digit: the row's other end, or the column's other end.",
          "The square that sees both far ends, where the far end's column meets the other far end's row, can't be the digit.",
        ],
        [
          "For one digit, look for a row and a column with two places each that meet in a box.",
          "Follow the two strings out to their far ends, and look at the square in line with both.",
        ]),
      lesson("emptyRectangle", "Empty Rectangle",
        "A box where a digit is confined to one row and one column, joined to a strong link.",
        [
          "In one box, suppose a digit's places all lie on one row and one column of the box, like a cross or an L. The other squares of the box are the empty rectangle. The digit must land on the cross's row or on its column.",
          "Now find a line outside the box where the digit has exactly two places, with one end in line with the cross's column. If that end is the digit, the box must use its row. If it isn't, the other end is.",
          "Either way, the square where the cross's row meets the far end's column can't be the digit.",
        ],
        [
          "Look for a box where a digit's places form an L or a cross.",
          "Then look along the cross's lines for a row or column where the digit has exactly two places.",
        ]),
      lesson("xyWing", "XY-Wing",
        "Three two-candidate squares: a pivot and two wings that share a digit.",
        [
          "Find a square with two candidates, say 1 and 2. This is the pivot. Now find two squares it sees: one with 1 and 3, and one with 2 and 3. These are the wings.",
          "If the pivot is 1, the first wing must be 3. If the pivot is 2, the second wing must be 3. Either way, one of the wings is 3.",
          "So any square that sees both wings can't be 3.",
        ],
        [
          "Look for squares with two candidates, and for three of them that hold three digits between them, two each.",
          "The pivot sees both wings. The wings don't need to see each other.",
        ]),
      lesson("xyzWing", "XYZ-Wing",
        "An XY-Wing whose pivot has all three digits.",
        [
          "Here the pivot has three candidates, say 1, 2 and 3. One wing has 1 and 3, the other 2 and 3, and the pivot sees both.",
          "Whatever the pivot turns out to be, a 3 ends up in the pivot or one of the wings: if the pivot is 1, the first wing is 3, if it is 2 the second wing is 3, and otherwise the pivot itself is 3.",
          "So a square that sees all three, the pivot and both wings, can't be 3. That means the removals are always in the pivot's box.",
        ],
        [
          "Look for a square with three candidates that sees two squares with two of those candidates each.",
          "The wings must share exactly one digit. Remove it from the squares that see all three.",
        ]),
      lesson("wWing", "W-Wing",
        "Two squares with the same pair, joined by a strong link on one of the digits.",
        [
          "Find two squares with the same two candidates, say 4 and 9, that don't see each other. Now find a unit where the 4 has exactly two places, one seeing the first square and one seeing the second.",
          "One of those two places is 4, so one of the pair squares is not 4, which makes it 9. At least one of the two pair squares is always 9.",
          "Any square that sees both pair squares can't be 9.",
        ],
        [
          "Look for two squares with the same two candidates in different rows, columns and boxes.",
          "Then look for a row, column or box that links them, where one of their digits has only two places.",
        ]),
    ],
  },
  {
    name: "Diabolical",
    blurb: "Chains of reasoning: follow a digit from square to square and see what must be true either way.",
    lessons: [
      lesson("uniqueRectangle", "Unique Rectangle",
        "A proper puzzle has one solution, so four squares can't all hold the same pair.",
        [
          "Take four empty squares at the corners of a rectangle, lying in two rows, two columns and exactly two boxes. If all four ended up with only the candidates 2 and 5, you could swap the 2s and 5s and get a second solution.",
          "A proper sudoku has exactly one solution, so that can never happen. If three corners have just 2 and 5, and the fourth has 2, 5 and something else, the fourth corner must be the something else.",
          "So you can remove 2 and 5 from the fourth corner. This is Unique Rectangle type 1. It is the one technique here that relies on the puzzle having a single solution, which every puzzle in this game does.",
        ],
        [
          "Look for two squares with the same pair in one row, and a third with the same pair below one of them.",
          "Check the rectangle covers exactly two boxes, then look at the fourth corner.",
        ]),
      lesson("simpleColouring", "Simple colouring",
        "Colour a digit's strong links in two colours: one colour is all true, the other all false.",
        [
          "A strong link is a unit where a digit has exactly two places: if one isn't the digit, the other is. Pick a digit, start at one square of a strong link and colour it blue. Colour its partner amber. Follow every strong link from there, swapping colours as you go.",
          "In the end, either every blue square is the digit, or every amber one is. Two things can follow. If two squares of the same colour see each other, that colour is impossible, and the digit leaves all of its squares. And if an uncoloured square sees both a blue and an amber square, it can't be the digit, because one of the two is.",
          "In a game, the colour pens (Colours, or C) are made for this: paint the chain as you follow it.",
        ],
        [
          "Pick a digit with several rows, columns or boxes where it has exactly two places.",
          "Colour the chain, then look for two of one colour in a unit, or a square that sees both colours.",
        ]),
      lesson("xChain", "X-Chains",
        "A chain on one digit that alternates strong and weak links.",
        [
          "An X-chain follows one digit along a line of squares. It starts with a strong link (a unit with only two places for the digit), then takes a weak link (the next square just sees the last one), then a strong link again, and so on, ending on a strong link.",
          "Read it from one end: if the first square isn't the digit, the second is, so the third isn't, so the fourth is, and so on to the last square. So at least one of the two ends is the digit.",
          "Any square that sees both ends can't be the digit. A skyscraper, a 2-string kite and an empty rectangle are all X-chains with two strong links. Longer chains reach further.",
        ],
        [
          "Find the strong links for one digit, then join them where an end of one sees an end of another.",
          "Look at the squares that see both ends of the whole chain.",
        ]),
      lesson("xyChain", "XY-Chains",
        "A chain of two-candidate squares that carries a digit from one end to the other.",
        [
          "An XY-chain runs through squares with two candidates each. Each square sees the next, and they share a digit. Start at a square with 1 and 2 and suppose it isn't 1. Then it is 2, so the next square (2 and 5) is 5, so the next (5 and 7) is 7, and so on.",
          "If the chain ends with a square that is forced to be 1, then one of the two ends is always 1: either the first square is 1, or the chain makes the last one 1.",
          "Any square that sees both ends can't be 1. An XY-Wing is the shortest XY-chain, with three squares.",
        ],
        [
          "Start at a two-candidate square and hop to another that shares one digit, carrying the other digit forward.",
          "When the digit you set aside at the start comes back at the end, look at the squares that see both ends.",
        ]),
    ],
  },
  {
    name: "Variants",
    blurb: "The same logic on the Variants boards: Diagonal, Jigsaw and Killer.",
    lessons: [
      lesson("diagonalSingle", "Diagonal: the extra units",
        "The two long diagonals hold 1 to 9 too. A digit with one place left on one goes there.",
        [
          "Diagonal sudoku (also called Sudoku X) has one extra rule: the two long diagonals, shaded on the board, must each hold every digit from 1 to 9 exactly once, just like the rows, columns and boxes.",
          "We call them the diagonal from the top left (R1C1 down to R9C9) and the diagonal from the top right (R1C9 down to R9C1). They cross in the middle square, R5C5, which belongs to both.",
          "Everything you know still works, and the diagonals add more. A square on a diagonal also sees the rest of that diagonal, so a digit there rules itself out along it. And a diagonal is a unit, so a digit with one place left on it goes there: a hidden single on the diagonal.",
        ],
        [
          "Check the diagonals for digits they are still missing, the same way you check a row.",
          "Remember the diagonal squares when you scan: a digit on a diagonal rules out more than a digit elsewhere.",
        ]),
      lesson("diagonalLocked", "Diagonal locked candidates",
        "Pointing and claiming between a box and a diagonal.",
        [
          "Pointing and claiming work wherever two units overlap in more than one square, and a box crossed by a diagonal is such a pair: the corner boxes and the middle box each share three squares with a diagonal.",
          "If a digit's places in a box all lie on a diagonal, the box's copy of the digit is on that diagonal, so the rest of the diagonal can't have it.",
          "Turned around: if a digit's places on a diagonal all lie in one box, the diagonal's copy is in that box, so the box's other squares can't have it.",
        ],
        [
          "Look at the boxes the diagonals pass through: boxes 1, 3, 5, 7 and 9.",
          "For each digit, check whether its places in the box all sit on the diagonal, or its places on the diagonal all sit in one box.",
        ]),
      lesson("jigsawSingle", "Jigsaw: irregular regions",
        "The boxes are replaced by nine odd-shaped regions. A digit with one place left in a region goes there.",
        [
          "In jigsaw sudoku the 3 by 3 boxes are gone. Instead the board is cut into nine irregular regions of nine squares each, drawn with thick borders. Every row, column and region holds 1 to 9 once.",
          "Regions are numbered 1 to 9 by the order of their first square, reading left to right, top to bottom.",
          "Cross-hatching works on a region just as on a box: every digit already in a row or column crosses out squares, and if one square of the region is left for the digit, it goes there. The odd shapes make this harder to see, because a region can reach into many rows and columns.",
        ],
        [
          "Follow each region's border carefully: a region often reaches into four or five rows.",
          "Small or narrow parts of a region, like a single square sticking out, are often where a digit is forced.",
        ]),
      lesson("leftovers", "The law of leftovers",
        "Rows at an edge and the regions mostly inside them hold the same digits, so what sticks out must match.",
        [
          "Take the top row. It holds every digit once. Find the region that lies mostly inside it: it holds every digit once too. Take away the squares they share, and what is left of the row must hold the same digits as what is left of the region.",
          "The same works for the top two rows and the two regions lying mostly inside them (each digit twice), and so on for up to four rows or columns at any edge of the board.",
          "The leftovers are usually only a few squares on each side, marked in two colours. Any candidate on one side that the other side can't hold goes.",
        ],
        [
          "Start at an edge: one, two or three rows or columns, and the regions that lie mostly inside them.",
          "Compare the squares that stick out on each side, and remove what doesn't match.",
        ]),
      lesson("cageCombination", "Killer: cage sums",
        "Dashed cages add up to their small number with no digit twice, which limits what each square can be.",
        [
          "Killer sudoku keeps the usual rules and adds cages: groups of squares outlined with dashes, each with a small sum in its corner. The digits in a cage must add up to that sum, and no digit can appear twice in a cage.",
          "Killer puzzles have few or no given digits: the cages do the work. Start with what each cage can hold. A cage of three adding to 6 can only be 1, 2 and 3. A cage of three adding to 24 can only be 7, 8 and 9.",
          "When some squares already have candidates removed, fewer combinations fit, and a square keeps only the digits that appear in a way of filling the cage that still works.",
        ],
        [
          "Small and large sums with few squares have the fewest ways: 6, 7, 23 and 24 in three squares, 10, 11, 29 and 30 in four.",
          "For each way to make the sum, check it fits the candidates of every square in the cage.",
        ]),
      lesson("rule45", "The 45 rule",
        "A row, column or box adds up to 45. Subtract the cages inside it to find the squares that stick out.",
        [
          "Every row, column and box holds 1 to 9, which adds up to 45. Add up the cages that lie wholly inside a box, and the squares of the box left over must make the rest. Those squares are called innies.",
          "Turned around: add up every cage that reaches into the box. Their squares outside the box, the outies, must make that total less 45.",
          "When only one innie or outie is still empty, you know it exactly. The same sum trick works for two or three rows, columns or boxes together: they add up to 90 or 135.",
        ],
        [
          "Look for a box, row or column whose cages are almost all inside it, with one or two squares poking out or in.",
          "Write down the sum, subtract the cages, and subtract the digits you already have.",
        ]),
      lesson("cagePointing", "Cage pointing",
        "A digit every way of filling a cage needs, with its places in one line or box, leaves the rest of it.",
        [
          "Sometimes every combination that fills a cage uses the same digit. A cage of three adding to 7 can only be 1, 2 and 4, so it must hold a 4 somewhere.",
          "If the squares of the cage that can hold that digit all lie in one row, column or box, the digit is in that unit inside the cage. No other square of the unit can have it.",
          "This is pointing with a cage in place of a box.",
        ],
        [
          "Find cages with few combinations, and the digit they all share.",
          "Check where that digit can go in the cage, and follow its row, column or box out of the cage.",
        ]),
    ],
  },
];

export const LESSONS: readonly Lesson[] = LEVELS.flatMap((l) => l.lessons);

export const lessonById = (id: string): Lesson | undefined => LESSONS.find((l) => l.id === id);

/** The lesson after `id` in the curriculum, or `null` after the last. */
export function nextLesson(id: string): Lesson | null {
  return LESSONS[LESSONS.findIndex((l) => l.id === id) + 1] ?? null;
}

/** The level a lesson belongs to. */
export const levelOf = (lesson: Lesson): Level => LEVELS.find((l) => l.lessons.includes(lesson))!;

/** The first lesson of the level called `name` (a Graded difficulty), if there is one. */
export const firstLessonOf = (name: string): Lesson | undefined => LEVELS.find((l) => l.name === name)?.lessons[0];

/** Whether the Graded puzzles use the lesson's technique when they decide a difficulty. */
export const isGraded = (lesson: Lesson): boolean => lesson.technique === null || techniqueById(lesson.technique).grader >= 0;

/** The notes lesson practises on the naked single positions, which is where notes first pay off. */
const NOTES_POSITIONS: readonly PositionData[] = POSITIONS.nakedSingle!.slice(0, 3);
/** The most squares a notes exercise asks about. */
const NOTES_CELLS = 3;

const positionsOf = (lesson: Lesson): readonly PositionData[] => (lesson.technique ? POSITIONS[lesson.technique]! : NOTES_POSITIONS);

/** How many practice positions a lesson has. */
export const practiceCount = (lesson: Lesson): number => positionsOf(lesson).length;

/** The squares a notes exercise asks about: the first few empty ones of the emptiest box. */
export function notesCells(grid: readonly number[]): number[] {
  const open = boxes.map((box) => box.filter((c) => grid[c] === 0));
  return open.reduce((best, cells) => (cells.length > best.length ? cells : best)).slice(0, NOTES_CELLS);
}

/** A fresh drill on practice position `index` of a lesson. */
export function practiceDrill(lesson: Lesson, index: number): Drill {
  const p = positionsOf(lesson)[index];
  if (!p) throw new RangeError(`${lesson.id} has no practice position ${index}`);
  const grid = parseGrid(p.grid);
  const solution = parseGrid(p.solution);
  if (!lesson.technique) return drillOf(grid, solution, { kind: "notes", cells: notesCells(grid) });
  return drillOf(grid, solution, { kind: "step", technique: lesson.technique }, p.cand ? decodeCand(p.cand) : undefined, dataLayout(p));
}

/** Whether a lesson ends with a whole puzzle to solve. */
export const hasPuzzle = (lesson: Lesson): boolean => lesson.technique !== null && lesson.technique in PUZZLES;

/** A fresh drill on the lesson's whole puzzle, whose hardest step is the lesson's technique; `null` when it has none. */
export function puzzleDrill(lesson: Lesson): Drill | null {
  const p = lesson.technique ? PUZZLES[lesson.technique] : undefined;
  return p ? drillOf(parseGrid(p.givens), parseGrid(p.solution), { kind: "solve" }, undefined, dataLayout(p)) : null;
}

/** One frame of a lesson's worked example. */
export interface DemoFrame {
  state: State;
  /** The step to highlight, or `null` for the opening frame. */
  step: Step | null;
  /** Whether the step's result (its digit, its struck candidates) is drawn. */
  result: boolean;
  /** Whether the board shows candidates. */
  candidates: boolean;
  text: string;
}

/**
 * A lesson's worked example, on a position of its own (the last one, so the
 * first practice positions stay fresh): the position, then the argument a
 * sentence at a time, then the result. Empty for the notes lesson.
 */
export function demoFrames(lesson: Lesson): DemoFrame[] {
  if (!lesson.technique) return [];
  const technique = techniqueById(lesson.technique);
  const state = positionState(POSITIONS[lesson.technique]!.at(-1)!);
  // The smallest instance on the board makes the clearest example.
  const step = technique.find(state).reduce((best, s) => (s.eliminations.length < best.eliminations.length ? s : best));
  const candidates = !technique.places;
  const frames: DemoFrame[] = [{ state, step: null, result: false, candidates, text: `Here is a position. ${step.nudge}` }];
  step.reason.forEach((_, i) => {
    const last = i === step.reason.length - 1;
    frames.push({ state: last ? apply(state, step) : state, step, result: last, candidates, text: step.reason.slice(0, i + 1).join(" ") });
  });
  return frames;
}
