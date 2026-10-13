# 3. Draw the shapes

A node shape describes a class: its attributes, its relations, and what counts as valid. The shapes supply the fields of the Properties panel and the tools of the palette.

## The Book shape

1. Select **Shape** in the palette and click an empty place on the canvas.
2. Type `Book` and press Enter. The typed name also sets the target class.
3. Click **+ attribute** on the card. Type `title` for the path and keep `xsd:string`.
4. Click the cardinality badge of the row until it says **1**: a book has exactly one title.
5. Add a second attribute `publicationYear`. Double-click the datatype pill and select `xsd:integer`.

## The Author shape

1. Create a second shape `Author` the same way.
2. Add the attribute `born` with the datatype `xsd:date`.
3. Hover the Author card and click the **+** on its right side. Select **city** as the path and the **Cities** scheme as the range. The line goes to the imported scheme.

## Connect the two

1. Hover the Book card and click **+**.
2. Type `author` and select the **Author** shape as the range.

A line with the cardinality `0..*` goes from Book to Author.

![The Book and Author shapes with the Cities scheme](/images/scratch-shapes.png)

The palette now has a **Book** tool and an **Author** tool. Each tool creates an instance of the target class of its shape.

Next: [Create instances](./04-instances).
