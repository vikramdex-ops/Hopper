// Built-in structured folder templates: the Dexterity project skeleton and the issue / submission pack.
// Derived from three real project trees (two twin detail-design packages and one as-built PDS job),
// keeping what those projects actually used and leaving out placeholders that stayed empty.
// Folder names are corrected English ("Superseded", "Technical", "STAAD"); numbers are assigned
// automatically ("0- Name", "1- Name" …) after conditional folders drop out, so there are no gaps.
import type { FolderTemplate } from './types'
import type { TemplateNode } from './template-model'

const DETAIL = "type == 'Detail design'"
const ASB = "type == 'As-built'"
const has = (d: string) => `disciplines has '${d}'`
const plain = (...names: string[]): TemplateNode[] => names.map((name) => ({ name }))
/** one folder per sub-project (when split), nothing else inside */
const split = (...names: string[]): TemplateNode[] => names.map((name) => ({ name, split: true }))
const gates: TemplateNode = { each: 'gates', name: '{item}' }
const areas: TemplateNode = { each: 'areas', name: '{area}' }
/** standalone, or twin split inside each discipline */
const ONE_TREE = "subs < 2 or layout == 'Split inside each discipline'"

export const PROJECT_TEMPLATE: FolderTemplate = {
  id: 'dexterity-project',
  name: 'Dexterity project',
  description: 'Project skeleton: disciplines, 3D CAD admin, trackers and outgoing documents. Fill three fields for a standalone project.',
  builtin: true,
  folders: [],
  root: '{job}-{name}<-{client}>< {type}><-{platform}>',
  numbering: { auto: true, start: 0, pad: 'none', sep: '- ' },
  subLabel: '{label}< ({unit})>',
  inputs: [
    { id: 'job', label: 'Job number', kind: 'text', required: true, placeholder: 'J130' },
    { id: 'name', label: 'Short name', kind: 'text', required: true, placeholder: 'DE-OIL' },
    { id: 'client', label: 'Client', kind: 'text', placeholder: 'Short code (optional)' },
    { id: 'type', label: 'Project type', kind: 'choice', options: ['Detail design', 'As-built'], default: 'Detail design', tokens: { 'Detail design': '', 'As-built': 'AS-BUILT' } },
    { id: 'platform', label: '3D platform', kind: 'choice', options: ['None', 'PDS', 'S3D', 'E3D/PDMS', 'Other'], default: 'S3D', tokens: { None: '', PDS: 'PDS', S3D: 'S3D', 'E3D/PDMS': 'E3D', Other: '' } },
    {
      id: 'disciplines',
      label: 'Disciplines in scope',
      kind: 'multi',
      options: ['Piping', 'Stress', 'Mechanical', 'Civil & Structural', 'Electrical', 'Instrumentation', 'Process', 'HSE', 'Document Control'],
      default: ['Piping', 'Stress', 'Mechanical', 'Civil & Structural', 'Instrumentation']
    },
    { id: 'subs', label: 'Sub-projects', kind: 'subs', hint: 'Leave empty for a standalone project. Add two or more for a twin / multi-package job: one fixed label each, used everywhere.' },
    { id: 'layout', label: 'Sub-project layout', kind: 'choice', options: ['Separate tree per sub-project', 'Split inside each discipline'], default: 'Separate tree per sub-project', when: 'subs >= 2' },
    { id: 'areas', label: 'Areas / skids', kind: 'list', placeholder: 'Interconnection, Skid-01..06', hint: 'Optional. Used for the master issued isometrics and stress mark-ups / support summaries.', when: 'subs == 0', advanced: true },
    { id: 'gates', label: 'Review gates', kind: 'list', default: ['60%', '90%'], placeholder: '60%, 90%', hint: 'Model reviews (detail design) or model audits (as-built).', advanced: true },
    { id: 'stressTool', label: 'Stress tool', kind: 'choice', options: ['CAESAR II', 'Other'], default: 'CAESAR II', tokens: { 'CAESAR II': 'CAESAR II', Other: 'Stress' }, when: `${has('Stress')} and ${DETAIL}`, advanced: true },
    { id: 'structTools', label: 'Structural tools', kind: 'multi', options: ['STAAD', 'Tekla'], default: ['STAAD', 'Tekla'], when: `${has('Civil & Structural')} and ${DETAIL}`, advanced: true },
    { id: 'le', label: 'LE folder (progress registers, audits)', kind: 'flag', default: true, advanced: true },
    { id: 'tq', label: 'Technical query register', kind: 'flag', default: true, advanced: true },
    { id: 'tieins', label: 'Tie-in register', kind: 'flag', default: true, when: `${has('Piping')} and ${DETAIL}`, advanced: true },
    { id: 'ug', label: 'Underground piping', kind: 'flag', when: `${has('Piping')} and ${DETAIL}`, advanced: true },
    { id: 'skids', label: 'Skid packages (skid GAD, lifting arrangement)', kind: 'flag', when: `${has('Piping')} and ${DETAIL}`, advanced: true },
    { id: 'asbuiltStage', label: 'As-built stage at the end', kind: 'flag', when: `${has('Piping')} and ${DETAIL}`, advanced: true },
    { id: 'isoCheck', label: 'Iso checking (automated + back-check)', kind: 'flag', when: `${has('Piping')} and ${DETAIL}`, advanced: true },
    { id: 'secSupports', label: 'Secondary supports (civil)', kind: 'flag', default: true, when: `${has('Civil & Structural')} and ${DETAIL}`, advanced: true },
    { id: 'outsourcing', label: 'Outsourcing exchange (civil)', kind: 'flag', when: `${has('Civil & Structural')} and ${DETAIL}`, advanced: true }
  ],
  tree: [
    {
      name: 'Documents from Client',
      children: [
        { name: 'Transmittals Received' },
        { name: 'Red Markups', when: ASB, children: [{ each: 'disciplines', name: '{item}', when: "item != 'Stress' and item != 'Document Control'" }] },
        { name: 'FCR', when: ASB },
        { name: 'Native Files', when: ASB },
        { name: 'Design Basis', when: DETAIL },
        { name: 'Plot Plan', when: DETAIL },
        { name: 'Vendor Documents', when: DETAIL, split: true }
      ]
    },
    { name: 'Procedures' },
    { name: 'LE Folder', when: 'le' },
    {
      name: 'Project Management',
      children: [...plain('Need List', 'Pending Activities', 'Plan of Deliverables', 'Master Document Tracker'), { name: 'As-Built Document Tracker', when: ASB }]
    },
    { use: 'disciplines', when: ONE_TREE },
    { each: 'subs', name: '{sub}', number: true, when: `not (${ONE_TREE})`, children: [{ use: 'disciplines' }, { use: 'outgoing' }] },
    {
      name: '3D CAD Admin',
      when: "platform != 'None'",
      children: [
        { name: 'Daily Navis', split: true },
        { name: 'Reference Models' },
        { name: 'Vendor Models', when: DETAIL },
        { name: 'RDB', when: "platform in ['PDS', 'S3D']" },
        { name: 'Working' },
        { name: 'Model Reviews', when: DETAIL, children: [{ ...gates, split: true }] },
        { name: 'Model Audits', when: ASB, children: [gates] },
        { name: 'Model Check', when: ASB },
        { name: 'Clash Reports', split: true },
        { name: 'Model Reports', when: DETAIL, split: true },
        { name: 'Iso Tracker', when: DETAIL }
      ]
    },
    { name: 'Technical Query Register', when: 'tq', children: plain('Template', 'Raised', 'Responses', 'Tracker', 'Transmittals', 'Reference') },
    { name: 'Document Control', when: has('Document Control'), children: plain('Transmittals Issued', 'VDRL') },
    { use: 'outgoing', when: ONE_TREE }
  ],
  blocks: {
    disciplines: [
      { name: 'Piping', when: has('Piping'), children: [{ use: 'asbuiltCore', when: ASB }, { use: 'asbuiltPiping', when: ASB }, { use: 'piping', when: DETAIL }] },
      { name: 'Piping Stress', when: has('Stress'), children: [{ use: 'stress', when: DETAIL }] },
      { name: 'Mechanical', when: has('Mechanical'), split: true, children: [{ use: 'asbuiltCore', when: ASB }, ...plain('Static Equipment', 'Rotating Equipment', 'Vendor Equipment GA').map((n) => ({ ...n, when: DETAIL }))] },
      { name: 'Civil & Structural', when: has('Civil & Structural'), children: [{ use: 'asbuiltCore', when: ASB }, { name: 'Check Prints', when: ASB }, { use: 'civil', when: DETAIL }] },
      { name: 'Electrical', when: has('Electrical'), children: [{ use: 'asbuiltCore', when: ASB }, { name: 'Standards & Specifications', when: DETAIL }, { use: 'common', when: DETAIL }] },
      { name: 'Instrumentation', when: has('Instrumentation'), children: [{ use: 'asbuiltCore', when: ASB }, { use: 'instrumentation', when: DETAIL }] },
      { name: 'Process', when: has('Process'), children: [{ use: 'asbuiltCore', when: ASB }, { use: 'common', when: DETAIL }] },
      { name: 'HSE', when: has('HSE'), children: [{ use: 'asbuiltCore', when: ASB }, { use: 'common', when: DETAIL }] }
    ],
    // as-built discipline set (the J129 0–7 template without the two folders no discipline ever used)
    asbuiltCore: plain('Red Markups', 'FCR', 'Related Documents', 'Working', 'Documents to be Issued', 'As-Built Markups Tracking Register', 'Issue Tracking Register', 'Comments from Client'),
    asbuiltPiping: [
      { name: 'As-Built Isometrics', children: plain('Automated Checking', 'Back-check') },
      { name: 'As-Built GAD & Layouts', children: plain('Automated Checking') }
    ],
    common: split('Inputs from Client', 'Comments from Client', 'Working'),
    piping: [
      ...plain('Standards', 'P&ID Legends'),
      { name: 'P&IDs', split: true },
      { name: 'Highlighted P&IDs', split: true, children: [gates] },
      ...plain('Line List', 'Piping Material Specification'),
      ...split('Equipment Layout', 'Piping GAD & Layouts'),
      ...plain('Hook-up Drawings', 'Piping Support Specification', 'Piping Support Standard'),
      { name: 'Tie-in Register', when: 'tieins' },
      { name: 'Underground', when: 'ug' },
      ...split('Speciality Items', 'Instruments'),
      { name: 'Valve Schedules', children: plain('Manual Valves', 'Auto Valves') },
      { name: 'Valve GADs' },
      ...split('Check Prints', 'Model Review Comments', 'Comments from Client'),
      { name: 'Queries', when: 'not tq' },
      { name: 'TDL Reports', split: true },
      { name: 'Iso Checking', when: 'isoCheck', children: plain('Automated Checking', 'Back-check') },
      { name: 'As-Built', when: 'asbuiltStage', split: true }
    ],
    stress: [
      ...plain('Stress Specification', 'Critical Line List'),
      { name: 'Stress Mark-ups', split: true, children: [areas] },
      { name: '{stressTool} Models', split: true },
      { name: 'Support Summary', split: true, children: [areas] },
      { name: 'ICPS', split: true },
      ...plain('Civil Loads', 'To Layout'),
      { name: 'Reports', split: true }
    ],
    civil: [
      { name: 'Inputs from Client', split: true },
      ...plain('Standards'),
      ...split('Foundation'),
      ...plain('Baseplate Details'),
      { name: 'STAAD', when: "structTools has 'STAAD'", split: true, children: plain('Input', 'Models', 'Reports', 'Comments') },
      { name: 'Tekla', when: "structTools has 'Tekla'", split: true, children: plain('Input for Tekla', '3D Model', 'Delivery from Tekla', 'Comments', 'Output Register') },
      ...plain('MTO'),
      { name: 'Secondary Supports', when: 'secSupports' },
      ...split('Working', 'Check Prints', 'Model Review Comments', 'Comments from Client', 'IDC'),
      { name: 'Outsourcing', when: 'outsourcing', children: plain('Sent', 'Received') }
    ],
    instrumentation: [
      ...plain('Standards & Specifications', 'P&IDs', 'Instrument GAD', 'Hook-up'),
      ...split('Model Review Comments', 'Inputs from Client', 'Comments from Client', 'Working')
    ],
    // outgoing: issued sets per discipline; dated issue folders come from the issue / submission pack
    outgoing: [
      {
        name: 'Documents to Client',
        children: [
          {
            name: 'Piping',
            when: has('Piping'),
            children: [
              { name: 'Isometrics', split: true },
              { name: 'Master Issued Isometrics', when: DETAIL, split: true, children: [areas] },
              { name: 'Piping GAD', when: DETAIL, split: true },
              { name: 'MTO', when: DETAIL, split: true },
              { name: 'Skid GAD', when: 'skids', split: true },
              { name: 'Skid Lifting Arrangement', when: 'skids', split: true },
              { name: 'GADs', when: ASB },
              { name: 'Layouts', when: ASB }
            ]
          },
          { name: 'Piping Stress', when: `${has('Stress')} and ${DETAIL}`, children: split('Stress Reports', 'Support Summary') },
          ...['Civil & Structural', 'Electrical', 'Instrumentation', 'Process', 'HSE'].map((d): TemplateNode => ({ name: d, when: has(d), split: true }))
        ]
      }
    ]
  }
}

export const ISSUE_PACK_TEMPLATE: FolderTemplate = {
  id: 'issue-pack',
  name: 'Issue / submission pack',
  description: 'One dated issue folder with a CHECK PRINT / NATIVE / PDF / RLM set per document. Create it inside the document type folder (for example Documents to Client › Piping › Isometrics).',
  builtin: true,
  folders: [],
  numbering: { auto: false },
  inputs: [
    { id: 'style', label: 'Folder', kind: 'choice', options: ['Issued on <date>', 'Batch-<n>_<date>'], default: 'Issued on <date>' },
    { id: 'batch', label: 'Batch number', kind: 'text', placeholder: '1', required: true, when: "style == 'Batch-<n>_<date>'" },
    { id: 'date', label: 'Issue date', kind: 'date' },
    { id: 'dateFormat', label: 'Date format', kind: 'choice', options: ['DD-Mon-YYYY', 'DD-MM-YYYY', 'YYYY-MM-DD'], default: 'DD-Mon-YYYY' },
    { id: 'docs', label: 'Document numbers', kind: 'list', multiline: true, placeholder: 'One per line', hint: 'One folder per document; leave empty for just the issue folder.' },
    { id: 'contents', label: 'Per document', kind: 'multi', options: ['CHECK PRINT', 'NATIVE', 'PDF', 'RLM'], default: ['CHECK PRINT', 'NATIVE', 'PDF'], hint: 'RLM for as-built issues.' }
  ],
  tree: [
    { name: 'Issued on {date}', when: "style == 'Issued on <date>'", children: [{ use: 'docs' }] },
    { name: 'Batch-{batch}_{date}', when: "style == 'Batch-<n>_<date>'", children: [{ use: 'docs' }] }
  ],
  blocks: {
    docs: [{ each: 'docs', name: '{item}', children: ['CHECK PRINT', 'NATIVE', 'PDF', 'RLM'].map((c) => ({ name: c, when: `contents has '${c}'` })) }]
  }
}

export const BUILTIN_TEMPLATES: FolderTemplate[] = [PROJECT_TEMPLATE, ISSUE_PACK_TEMPLATE]

/** The simple "Project folder" Hopper shipped before; a saved copy of it is replaced by the built-in. */
export const OLD_DEFAULT_PROJECT = ['01_Incoming', '02_Working', '03_Outgoing', '04_Transmittals', '05_References', '06_Correspondence']
