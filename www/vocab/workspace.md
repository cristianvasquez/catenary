# Catenary workspace vocabulary

The settings of a workspace. The workspace file (TriG) stores them in its manifest graph. Paths are relative to the folder of the workspace file.

Namespace: `https://cristianvasquez.github.io/catenary/vocab/workspace#` (prefix `ws:`)

Turtle: [workspace.ttl](./workspace.ttl){target="_self"}

This page is generated from the Turtle file by `pnpm www:vocab`. Do not edit it.

## ws:Workspace {#Workspace}

- Type: `rdfs:Class`
- Label: Workspace

The settings of a workspace. The subject is the manifest graph &lt;urn:name:workspace&gt;.

## ws:defaultFile {#defaultFile}

- Type: `rdf:Property`
- Label: default file
- Domain: [ws:Workspace](#Workspace)
- Range: `xsd:string`

The file for new subjects when "near" finds no file.

## ws:exclude {#exclude}

- Type: `rdf:Property`
- Label: exclude
- Domain: [ws:Workspace](#Workspace)
- Range: `xsd:string`

A glob of files that are not model files. The glob is relative to the folder of the workspace file.

## ws:imported {#imported}

- Type: `rdf:Property`
- Label: imported
- Domain: [ws:Workspace](#Workspace)
- Range: `xsd:string`

A glob of imported model files. Catenary reads them and does not change them. The glob is relative to the folder of the workspace file.

## ws:language {#language}

- Type: `rdf:Property`
- Label: language
- Domain: [ws:Workspace](#Workspace)
- Range: `xsd:string`

The language of the labels that Catenary shows, as a language tag such as "en".

## ws:placeConcepts {#placeConcepts}

- Type: `rdf:Property`
- Label: place concepts
- Domain: [ws:Workspace](#Workspace)
- Range: `xsd:string`

Where new SKOS resources go: a file path, or "near" (near their kind).

## ws:placeInstances {#placeInstances}

- Type: `rdf:Property`
- Label: place instances
- Domain: [ws:Workspace](#Workspace)
- Range: `xsd:string`

Where other new subjects go: a file path, or "near" (near their kind).

## ws:placeShapes {#placeShapes}

- Type: `rdf:Property`
- Label: place shapes
- Domain: [ws:Workspace](#Workspace)
- Range: `xsd:string`

Where new shapes go: a file path, or "near" (near their kind).

## ws:protect {#protect}

- Type: `rdf:Property`
- Label: protect
- Domain: [ws:Workspace](#Workspace)
- Range: `xsd:string`
- Deprecated: yes

The old name of ws:imported. Catenary reads it and does not write it.

## ws:validation {#validation}

- Type: `rdf:Property`
- Label: validation
- Domain: [ws:Workspace](#Workspace)
- Range: `xsd:string`

What SHACL validation checks: "off", "views" (the elements on the open views) or "all". Without a value: "all".
