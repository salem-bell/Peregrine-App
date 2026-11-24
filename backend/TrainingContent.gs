/**
 * Peregrine Team – Training content: the Employee Manual and the reference library.
 * Edit the words here, paste this file into Apps Script (both sheets) and deploy a New version.
 * When the manual changes in a way everyone must re-read, change Settings › Manual version
 * (e.g. 2026-12) and everyone is asked to sign again.
 * Blocks are HTML text, or a live block: sidework (opens on today) or deposit (drawer calculator).
 * Lists with class="tick" become tap-to-check lists that reset every day. Keep door codes and POS logins out.
 */
function trManualChapters_() {
  return [
      {
        title: 'Welcome to Peregrine',
        intro: 'Read this before your first shift.',
        sections: [
          {
            title: 'Who we are',
            b: [`
<p><i>Falco peregrinus</i> translates to "wandering falcon" or "pilgrim."</p>
<p>Coffee shops have a common problem: it's easy to find great coffee with bad service, or bad coffee with great service. The difference is <b>customer service</b> versus <b>hospitality</b>. Customer service meets the basic need. Hospitality creates a warm, welcoming place where guests feel valued and remembered.</p>
<div class="note"><b>Our first priority is hospitality.</b></div>
<p>Our mission is to deliver an exceptional coffee experience built on precision, craftsmanship and pilgrimage.</p>
<h3>Our four promises</h3>
<table><tr><th>Promise</th><th>What it means</th></tr>
<tr><td><b>Strict Sourcing</b></td><td>From any region, we may taste twenty coffees before choosing the one worthy of our shelves.</td></tr>
<tr><td><b>Direct Trade</b></td><td>Great coffee starts with great relationships. Through our own visits and trusted partners, we build lasting connections between grower, roaster and guest.</td></tr>
<tr><td><b>Precision Roasting</b></td><td>Each batch is tailored to the coffee's character and refined through careful cupping.</td></tr>
<tr><td><b>Dependability</b></td><td>Not every coffee is everyone's favorite, but every guest can trust that every cup meets the same standard and that we'll do everything possible to make their visit memorable.</td></tr></table>`]
          }
        ],
        check: [
          ['What\'s the difference between customer service and hospitality?', ['Service meets the need; hospitality makes guests feel valued and remembered', 'They mean the same thing', 'Hospitality is only for regulars', 'Service is faster'], 'Our first priority is hospitality.'],
          ['Which promise means every cup meets the same standard?', ['Dependability', 'Strict Sourcing', 'Direct Trade', 'Precision Roasting'], 'Every guest can trust every cup.']
        ]
      },
      {
        title: 'How we serve',
        intro: 'Seven steps, every guest, every time.',
        sections: [
          {
            title: 'Steps of service',
            b: [`
<ol class="steps">
<li><b>Enter a prepared environment.</b> The space looks great; lights, music and temperature are right. Smile.</li>
<li><b>Greet your guests (5ft/10ft rule).</b> Within <b>10 feet</b>, make eye contact or give guests the grace to look around, and let them know you'll be right with them. Within <b>5 feet</b>, smile, say hello and invite them in.</li>
<li><b>Discover why they're here.</b> What brought them in? Have they been here before? Always look to extend the party.</li>
<li><b>Guide them to a great product.</b> Know the menu and describe each style of coffee. Name a favorite or a best seller. Rising tides lift all ships: recommend great local shops and restaurants too.</li>
<li><b>Engage and delight.</b> Chat while they wait, surprise them with hospitality, and anticipate their needs.</li>
<li><b>Check in.</b> Try to find out if the guest has feedback.</li>
<li><b>Farewell.</b> Thank them for spending time with us. Be genuine and try to address them by name when possible.</li></ol>
<h3>Reviews</h3>
<p>If a guest has had a great experience, invite them to leave us a review. Don't ask them to mention you or any teammate by name, and never offer anything in exchange for a review.</p>`]
          }
        ],
        check: [
          ['A guest is about 5 feet away. What do you do?', ['Smile, say hello and invite them in', 'Wait for them to speak first', 'Just make eye contact', 'Start taking their order immediately'], 'Within 5 feet: smile, hello, invite them in.'],
          ['A regular tells you this was the best latte they\'ve had. What\'s okay to say?', ['"We\'d love a review if you have a minute!"', '"Please mention my name in a review."', '"Leave us 5 stars and I\'ll get you a free cookie."', 'Nothing; we never mention reviews'], 'Invite a review, but never ask for names and never offer anything for one.']
        ]
      },
      {
        title: 'Dress code',
        sections: [
          {
            title: 'What to wear',
            b: [`
<table><tr><th>Grooming and general</th><th>Clothing</th></tr>
<tr><td><ul><li>Excellent hygiene: hair, nails, clothes and shoes neat and clean.</li>
<li>Perfume and cologne subtle, so they don't compete with the coffee.</li>
<li>Beards neatly trimmed.</li>
<li>Hair at shoulder length or longer is pulled back.</li>
<li>Aprons optional; recommended if you're worried about stains.</li>
<li>No display of discrimination.</li></ul></td>
<td><ul><li>Pants in neutral colors with no patterns; earthy tones are ideal.</li>
<li>No shorts or short skirts, dresses, etc. behind the bar.</li>
<li>Collared shirts preferred; approved nicer t-shirts allowed.</li>
<li>Graphics on shirts are fine if subtle and appropriate (the Lead on shift has discretion).</li>
<li>Shirts must cover the belly button; no cropped tops.</li>
<li>All clothing clean and in good condition; nothing frayed.</li></ul></td></tr></table>
<div class="warn"><b>Required at all times:</b> closed-toe, closed-heel shoes. Slip-resistant soles are recommended.</div>`]
          }
        ],
        check: [
          ['Which of these is required on every shift?', ['Closed-toe, closed-heel shoes', 'An apron', 'A collared shirt', 'Black pants'], 'Shoes are the one hard requirement.'],
          ['Who decides if a shirt graphic is okay?', ['The Lead on shift', 'Any teammate', 'Guests', 'Nobody; graphics aren\'t allowed'], 'Subtle and appropriate, at the Lead\'s discretion.']
        ]
      },
      {
        title: 'Your shifts',
        sections: [
          {
            title: 'Attendance, call-outs and swaps',
            b: [`
<ul>
<li>Be clocked in and ready at your scheduled start time.</li>
<li>If you're going to be late, <b>call</b> the Lead on shift or the Manager before your start time.</li>
<li>If you can't work a shift, <b>call the Manager</b> as soon as you know, and before the shift starts. <b>A text alone is not a call-out.</b> Try to find coverage, but the shift is yours until someone else is approved for it.</li>
<li><b>Shift swaps:</b> arrange the swap with a teammate, then send it to a Lead to check coverage and hours. Every swap needs the Manager's final approval before it's official.</li>
<li>On a slow shift, the Lead may send someone home early or call off a scheduled shift. Your timecard shows the hours you actually worked.</li>
<li>The Manager may ask you to a one-on-one work meeting, sometimes on a day off. Meeting time is paid and goes on your timecard. You'll get notice when possible; if you can't make it, tell the Manager right away.</li>
<li>Repeated lateness or missed shifts follow the corrective action steps (chapter 5).</li></ul>`]
          },
          {
            title: 'Breaks, shift drinks, discounts and tips',
            b: [`
<table><tr><th>Breaks</th><th>Shift drink</th><th>Off-shift discount</th></tr>
<tr><td>Optional, and scheduled by the Lead on shift around the flow of service. Don't leave the bar uncovered.</td>
<td>One per full shift worked, made and drunk on that shift; it can't be saved for another day. Ring it in as "Shift Drink Discount." Quality-control tasting doesn't count, within reason.</td>
<td>50% off menu items for yourself (retail excluded, except coffee beans). Paying for others: the discount applies to two items total on the ticket.</td></tr></table>
<h3>Tips</h3>
<ul><li><b>Card (POS) tips</b> are divided automatically by total tipped hours worked.</li>
<li><b>Cash tips</b> come out of the jar at every shift change. When the next shift arrives, the outgoing barista removes what has built up. When the outgoing barista leaves, they split anything collected during the overlap with the person still on. This repeats all day.</li>
<li><b>Training:</b> training shifts 1–4 are not in the tip pool. Training shifts 5–8 are.</li></ul>`]
          }
        ],
        check: [
          ['You\'re sick and can\'t work your shift tomorrow. What counts as a call-out?', ['Calling the Manager before the shift', 'Texting the Manager', 'Texting a coworker', 'Posting in the group chat'], 'A text alone is not a call-out.'],
          ['You\'re off today and buying drinks for two friends. How does the discount work?', ['50% off two items total on the ticket', '50% off everything', 'No discount when off shift', 'One free drink'], 'Two items total when paying for others.'],
          ['You\'re on your third training shift. Are you in the tip pool?', ['No; shifts 1–4 aren\'t, shifts 5–8 are', 'Yes, from day one', 'Only for cash tips', 'Only after Level II'], 'Training shifts 5–8 are in the pool.']
        ]
      },
      {
        title: 'Conduct and corrective action',
        sections: [
          {
            title: 'Conduct, harassment and phones',
            b: [`
<p>Treat guests and teammates with respect. <b>Discrimination, harassment (including sexual harassment), threats, violence, theft and working impaired</b> are not tolerated and can lead to immediate suspension or termination.</p>
<p><b>Reporting:</b> tell the Manager, or the appropriate authority if the concern involves the Manager. Reports are taken seriously and handled as privately as possible. Retaliation against anyone who reports in good faith is not allowed.</p>
<p><b>Phones:</b> keep personal phones off the bar and out of sight of guests during service. Check them on breaks. Emergencies are an exception; tell the Lead on shift. Managers and Leads may use phones for work-related communications and essential functions.</p>`]
          },
          {
            title: 'Corrective action steps',
            b: [`
<p>Most problems are fixed with a quick, private word from a Lead. If the same issue keeps happening, it moves through these steps. The Manager handles every step after coaching.</p>
<table><tr><th>Step</th><th>What it looks like</th></tr>
<tr><td>Coaching</td><td>A Lead or the Manager corrects it with you privately. Nothing is written up.</td></tr>
<tr><td>Documented verbal warning</td><td>A conversation with the Manager, recorded on the write-up form.</td></tr>
<tr><td>Written warning</td><td>A signed write-up. A probation period may be added.</td></tr>
<tr><td>Final written warning</td><td>A signed write-up stating that the next occurrence may end your employment.</td></tr>
<tr><td>Termination</td><td>Decided by the Manager.</td></tr></table>
<ul><li>The Manager may start at whatever step the situation calls for.</li>
<li>A write-up counts for 12 months; after 12 months with no repeat, the next issue starts again at coaching.</li>
<li>You'll always get a copy, and you can add your side in writing. <b>Signing means you received it, not that you agree.</b></li>
<li>Harassment, threats or violence, theft or dishonesty, working impaired and discrimination skip these steps and go straight to the Manager.</li></ul>`]
          }
        ],
        check: [
          ['Your concern involves the Manager. Who do you report it to?', ['The appropriate authority above or outside the Manager', 'Nobody', 'A guest', 'The Manager anyway'], 'Reports are handled as privately as possible, with no retaliation.'],
          ['You get a written warning and disagree with it. What does signing mean?', ['That you received it, not that you agree', 'That you agree with it', 'That you accept termination', 'That it\'s permanent'], 'You can also add your side in writing.'],
          ['How long does a write-up count?', ['12 months', '30 days', 'Forever', '6 months'], 'After 12 months with no repeat, it resets to coaching.']
        ]
      },
      {
        title: 'Food safety',
        sections: [
          {
            title: 'Certificates, handwashing, illness and allergies',
            b: [`
<ul><li>Every team member needs an accredited <b>Texas food handler certificate</b>. State law allows 60 days from hire; Peregrine requires it <b>by the end of your second week</b>. Give the Manager a copy.</li>
<li><b>Wash your hands</b> when you arrive, after breaks, after handling trash or cash, and whenever you switch tasks.</li>
<li><b>Don't work</b> if you're vomiting, have diarrhea, a fever with sore throat, or jaundice. Tell the Manager before your shift.</li>
<li><b>Allergies:</b> guests are responsible for telling us about allergies. Our milks are whole, half &amp; half, oat, almond, coconut, banana and pistachio; <b>almond and pistachio are tree nuts</b>. We use shared pitchers and steam wands, so if a guest asks, tell them exactly what's in the drink and that our equipment is shared.</li></ul>`]
          }
        ],
        check: [
          ['When is your food handler certificate due at Peregrine?', ['By the end of your second week', 'Within 60 days', 'Before your first shift', 'Within a year'], 'State law allows 60 days; we require two weeks.'],
          ['You woke up with a fever and sore throat. What do you do?', ['Don\'t work; tell the Manager before your shift', 'Work but wear gloves', 'Work the register only', 'Text a coworker'], 'Those symptoms keep you off shift.']
        ]
      },
      {
        title: 'Certification and pay',
        intro: 'How you grow at Peregrine.',
        sections: [
          {
            title: 'Levels, tests and raises',
            b: [`
<table><tr><th>Level</th><th>How you get there</th></tr>
<tr><td><b>Level I</b></td><td>Take the Level I test in the portal within your first 4 shifts. Until you reach Level II, you never open alone, close alone, or count and close the drawer alone.</td></tr>
<tr><td><b>Level II</b></td><td>Take the Level II test in the portal; it's graded automatically. The <b>$0.50/hr raise</b> comes when you've passed the Level II test <b>and</b> the Coffee Knowledge test, <b>and</b> a Lead or Manager acknowledges you're proficient on shift.</td></tr>
<tr><td><b>Lead (Level III)</b></td><td>By the Manager's invitation: a written assessment and an observed shift.</td></tr></table>
<p>Managers and Leads have the right to retest you in person, or observe you on shift, to decide whether you're ready.</p>
<p>Every test has a study guide (Training › Study &amp; tests). Read it once and the test unlocks. Level II and Level IV can be taken once a week.</p>`]
          }
        ],
        check: [
          ['You\'ve passed Level II and Coffee Knowledge online. What else is needed for the raise?', ['A Lead or Manager acknowledging your proficiency', 'Nothing else', 'A signed paper test', '90 days of employment'], 'All three are required.']
        ]
      },
      {
        title: 'Keep handy',
        sections: [
          {
            title: 'Fact sheet',
            b: [`
<table>
<tr><td><b>Address</b></td><td>514 Lockwood Dr, Ste 1, Richardson, TX 75080</td></tr>
<tr><td><b>Phone</b></td><td>(682) 480-5080</td></tr>
<tr><td><b>Hours</b></td><td>Mon–Fri 6am–6pm · Sat 7am–6pm · Sun 7am–3pm</td></tr>
<tr><td><b>Instagram</b></td><td>@peregrineroasterstx</td></tr>
<tr><td><b>Website</b></td><td>peregrineroasters.com</td></tr>
<tr><td><b>Guest Wi-Fi</b></td><td>Network: Peregrine Guest Wifi · Password: raisedintexas</td></tr></table>`]
          }
        ]
      }
    ];
}

/** Reference docs. who: 'all' or 'lead' (Leads and Managers). The Drink Build Menu, Prep Recipe Book and shift
    checklists already live in the app (Recipes and Lists), so the library links to them instead of copying them. */
function trResources_() {
  return [
    { id: 'drinks', title: 'Drink Build Menu', icon: '❦', who: 'all', blurb: "Every drink, in the app's recipe book.", more: 'recipes' },
    { id: 'prep', title: 'Prep Recipe Book', icon: '❧', who: 'all', blurb: 'Syrups, concentrates and batches, in the recipe book.', more: 'recipes' },
    { id: 'shifts', title: 'Shift Checklists', icon: '✓', who: 'all', blurb: 'Opening, mid and closing, in Lists.', tab: 'lists' },
    {
      id: 'cleaning', title: 'Espresso Machine Cleaning Guide', icon: '◇', who: 'all',
      blurb: 'Backflushing, portafilters, screens, steam wands, carafes and weekly deep cleans.',
      sections: [
        { title: 'Products', b: [`<p><b>Cafiza</b> for all coffee-related machines and equipment. <b>Rinza</b> tablets for all milk-related equipment.</p>`] },
        { title: '1. Groupheads (backflush)', b: [`
<ul class="tick"><li>Swap the basket in each portafilter for a blank; add 1g Cafiza to each blank.</li>
<li>Lock in and run the group 10 seconds on, 10 seconds off, 5 times.</li>
<li>Remove the portafilter, dump the water, rinse the blank.</li>
<li>Lock back in with the blank only (no Cafiza): 10 on / 10 off × 5 to rinse.</li>
<li>Repeat for each group. Groups 1 and 2 start at 5pm; the last group goes after close.</li></ul>`] },
        { title: '2. Portafilters and baskets', b: [`
<ul class="tick"><li>Baskets go in the Cafiza bucket (hot water + 2–3g Cafiza).</li>
<li>Once each group is backflushed, add the rest of the portafilter metal parts.</li></ul>
<div class="warn">The rubber handles must never touch the water.</div>`] },
        { title: '3. Shower screens', b: [`
<ul class="tick"><li>Carefully remove each screen with the flathead screwdriver.</li>
<li>Put screens and screws in the same Cafiza bucket.</li>
<li>Soak 10 minutes, rinse and reassemble.</li></ul>`] },
        { title: '4. Steam wands (Rinza)', b: [`
<ul class="tick"><li>1 Rinza tablet in a milk pitcher with about 10oz water.</li>
<li>Steam 30–60 seconds or until boiling over.</li>
<li>Let it soak 1–2 minutes.</li><li>Dump the water.</li>
<li>Run steam 20 seconds to clear water and chemical.</li><li>Wipe the wand.</li></ul>`] },
        { title: '5. Drip tray and finish', b: [`
<ul class="tick"><li>Remove the three drip tray pieces and wash them in the sink.</li>
<li>Rinse and dry everything from the Cafiza bucket; reassemble the portafilters.</li>
<li>Wipe down the machine body.</li></ul>`] },
        { title: 'Daily: drip carafes', b: [`
<ul class="tick"><li>Drain any remaining coffee from the pot.</li>
<li>Add 2–3g Cafiza; run "Rinse," then "Large."</li>
<li>Scrub the pot with the dish scrubber.</li>
<li>Drain and run the "Rinse" cycle again.</li>
<li>Label the pot "clean" on the outside.</li></ul>`] },
        { title: 'Weekly deep cleans', b: [`
<table><tr><th>Day</th><th>Task</th><th>How</th></tr>
<tr><td>Wednesday</td><td>Grinder deep clean</td><td>Disassemble the hoppers and chute; purge stale grounds and oils from the burrs</td></tr>
<tr><td>Wednesday</td><td>Top of espresso machine</td><td>Remove and sanitize the cups; sanitize the top panels</td></tr>
<tr><td>Thursday</td><td>Curtis drip machine</td><td>Clean the brewer and remove stale grounds from the shower head</td></tr>
<tr><td>Sunday</td><td>Steam wand descale</td><td>Remove the tips, soak them in Rinza, purge the wands and scrub after</td></tr></table>`] },
        { title: 'Report problems', b: [`<p>A leaking portafilter usually means a worn group gasket. Any equipment problem that isn't an emergency gets reported to the Manager before the end of the shift.</p>`] }
      ]
    },
    {
      id: 'sidework', title: 'Side Work Checklist', icon: '▦', who: 'all',
      blurb: 'Weekly deep-clean tasks by day. Opens on today.',
      sections: [{ title: 'Side work by day', b: [{ live: 'sidework' }] }]
    },
    {
      id: 'drawer', title: 'Drawer Closing Guide', icon: '$', who: 'all',
      blurb: 'Counting and closing the drawer, discrepancies, the deposit and cash tips. Includes a deposit calculator.',
      sections: [
        { title: 'Before you start', b: [`<p>The drawer always starts the day at <b>$200</b>. Log into the POS on the Cashier's profile (upper right corner of the main screen). Ask your Lead for the code.</p>`] },
        { title: '1. Close open tickets', b: [`
<p>Open tickets mean something went wrong or a tab wasn't settled.</p>
<ul class="tick"><li>If an open ticket is for <b>Amy, Tim or Kahles</b>, write each ticket's amount on a separate sheet of paper labeled <b>"Kahles Tab"</b> with the date. This sheet goes in with the deposit.</li>
<li>Void every other open ticket and choose the most relevant void reason.</li></ul>`] },
        { title: '2. Close out pending tips', b: [`<p>Zero out all pending tips for the day.</p>`] },
        { title: '3. Count and close the drawer', b: [`
<ul class="tick"><li>Select <b>Count and Close</b>, then <b>Count Bills</b>.</li>
<li>Enter the number of bills in each denomination (four $20s → enter 4 in the $20 field; thirty $1s → enter 30).</li>
<li>Round the drawer total to the nearest dollar. Everything above $200 is the deposit.</li>
<li>With the drawer at $200 and the deposit set aside, select <b>Print Summary</b>.</li></ul>`, { live: 'deposit' }] },
        { title: '4. If the count doesn\'t match', b: [`
<ol class="steps"><li><b>Recount</b> before doing anything else.</li>
<li>Still off by <b>$5 or less</b>: write the amount, date, shift and cashier on a piece of paper attached to the deposit.</li>
<li>Still off by <b>more than $5</b>: log it AND tell the Manager the same day.</li>
<li>If the same register or cashier is off again, the Manager is told even if it's under $5.</li></ol>
<div class="warn">Never cover a shortage with tips or your own money. Report it first.</div>`] },
        { title: '5. Wrap the deposit', b: [`
<ul class="tick"><li>Wrap the deposit cash in the printed summary receipt, with the Kahles Tab sheet if there is one.</li>
<li>Pull more receipt paper from the printer and wrap the whole deposit.</li>
<li>Write clearly on the outside: today's date, your name and the deposit amount.</li>
<li>Put the deposit in the bank bag in the milk storage room.</li></ul>`] },
        { title: '6. Clock out the Cashier\'s profile', b: [`<p>That's it.</p>`] },
        { title: 'Cash tips (every shift change)', b: [`<p>Cash tips come out of the jar at every change in shift. When the next shift arrives, the outgoing barista removes what has built up. When the outgoing barista leaves, they split anything collected during the overlap with the person still on. This repeats all day. Card tips are split automatically by tipped hours.</p>`] }
      ]
    },
    {
      id: 'policies', title: 'Policy Booklet', icon: '❏', who: 'lead',
      blurb: 'For Leads and Managers: escalation authority, thresholds, and who handles what.',
      sections: [
        { title: 'How to use this booklet', b: [`<p>This booklet gives Leads a consistent, written answer when a judgment call comes up on shift: escalation authority, thresholds, and who handles what. Barista-facing rules live in the Employee Manual. New policies are added in order.</p>`] },
        { title: 'Policy 1 · Cash drawer discrepancies', b: [`<p>If the drawer count doesn't match at the end of any shift, the Lead or closing cashier <b>recounts</b> before doing anything else.</p>
<ul><li><b>$5 or less:</b> log the variance (amount, date, shift, cashier) and monitor. No Manager notification unless the same register or cashier shows a repeat variance.</li>
<li><b>More than $5:</b> notify the Manager the same day, in addition to logging it.</li>
<li>A short drawer is reported first. Once it's reported, the difference may be made up from cash sales so the Manager knows the cash will come in low. Never top it up from change or personal money.</li></ul>`] },
        { title: 'Policy 2 · Guest recovery authority', b: [`<p>When a service failure happens (wrong drink, quality issue, or another mistake on our part), a Lead may comp or remake <b>up to one item per incident</b> without prior Manager approval. Anything beyond one item (more items, a full refund, comps across several transactions) needs Manager approval first.</p>
<p>This applies only to genuine service failures, not situations where we made no error (a declined card, a guest unhappy about pricing). Price complaints get an explanation of our value, never a refund or discount.</p>`] },
        { title: 'Policy 3 · Conduct and performance escalation', b: [`<ul><li><b>First occurrence:</b> the Lead addresses it with in-the-moment coaching. No further escalation required.</li>
<li><b>Repeat occurrence:</b> the Lead reports it to the Manager and posts a summary in the Lead channel so other Leads can watch for it. Any write-up is the Manager's.</li>
<li><b>Serious misconduct</b> (harassment, threats, theft, impairment) skips coaching and goes straight to the Manager.</li></ul>`] },
        { title: 'Policy 4 · Safety, equipment and security incidents', b: [`<p>In any safety incident (injury, immediate danger, security concern), the Lead handles the emergency first, including calling 911 if warranted, then notifies the Manager as soon as possible. Non-emergency equipment failures are reported to the Manager before the end of the shift in which they're found.</p>`] },
        { title: 'Policy 5 · Certification', b: [`<ul><li><b>Level I:</b> taken in the portal within a new hire's first 4 shifts (12 of 15 to pass).</li>
<li><b>Level II:</b> taken in the portal and graded automatically. No sign-off.</li>
<li><b>Level III (Lead):</b> by Manager invitation; written assessment and observed shift, scored by the Manager.</li>
<li>Managers and Leads have the right to retest anyone in person, or observe them on shift, to determine readiness.</li></ul>`] },
        { title: 'Policy 6 · Shift swaps and schedule changes', b: [`<p>Leads may coordinate swap requests and check them for coverage and hour-limit issues, but may not approve a swap on their own. All swaps need the Manager's final approval before they're posted.</p>`] },
        { title: 'Policy 7 · Lead communication channels', b: [`<p>The Lead channel is for (1) trainee progress notes after every training shift and (2) recurring conduct or performance issues raised to the Manager and other Leads (Policy 3). One-off coaching moments and routine shift communication are handled directly with the team member or on the shift whiteboard.</p>`] },
        { title: 'Policy 8 · Shift drinks and employee discounts', b: [`<p>One shift drink per full shift worked, made and consumed on that shift; it can't be banked. Ring it in as "Shift Drink Discount." Quality-control tasting is excluded, within reason. Off-shift: 50% off menu items (retail excluded, except coffee beans), only for items the employee will consume. If paying for others, the discount applies to two items total on the ticket.</p>`] },
        { title: 'Policy 9 · Level I restrictions', b: [`<p>Until they reach Level II, a Level I barista may not open alone, close alone, or count and close the drawer alone. Schedule every Level I open and close with a Level II barista or a Lead, and have that person verify the drawer count. This also applies when staff are called off (Policy 13).</p>`] },
        { title: 'Policy 10 · Level raises', b: [`<table><tr><th>Level</th><th>Raise</th><th>When</th></tr>
<tr><td>Level I</td><td>$0</td><td></td></tr>
<tr><td>Level II</td><td>$0.50/hr</td><td>Only when the barista has passed the Level II test <b>and</b> the Coffee Knowledge test, <b>and</b> a Lead or Manager acknowledges their proficiency</td></tr>
<tr><td>Level III (Lead)</td><td>$1.50/hr</td><td>On promotion</td></tr></table>
<p>Training shifts 1–4 are untipped, so they must be paid at least the full $7.25 minimum wage if a tip credit is otherwise used.</p>`] },
        { title: 'Policy 11 · Kahles house tab', b: [`<p>Open tickets for Amy, Tim or Kahles are not voided at close. The closer writes each ticket's amount on a separate dated sheet labeled "Kahles Tab" and includes it with the deposit. All other open tickets are voided with the closest reason.</p>`] },
        { title: 'Policy 12 · Guest reviews', b: [`<ul><li>When a guest has had a great experience, team members may invite them to leave a review.</li>
<li>No team member may ask a guest to mention them or any teammate by name, offer anything in exchange for a review, or review Peregrine themselves.</li>
<li>A Lead who sees a review asked for by name, or in exchange for something, coaches it in the moment and reports it to the Manager (Policy 3).</li></ul>`] },
        { title: 'Policy 13 · Calling off staff on slow shifts', b: [`<p>A Lead may call off a scheduled barista, or send one home early, when the shift's volume doesn't need them.</p>
<ul><li>Ask for volunteers first.</li><li>Never leave a Level I barista to open, close or count the drawer alone (Policy 9).</li>
<li>Tell the Manager the same day, and make sure clock-out times match the hours actually worked.</li></ul>`] }
      ]
    }
  ];
}

const TR_SIDEWORK_ = {
  Monday: [['Scrub floor drains', 'Remove the covers; scrub the drains and the covers.'], ['Door and window glass deep clean', 'Front door and sliding window, inside and outside (the daily spot clean is on the shift lists).'], ['Deep clean restrooms', 'Toilet, sink, floors, mirrors and walls; wipe the exterior walls; sweep and mop as needed.']],
  Tuesday: [['Storage room fridges', 'Empty and wipe clean both fridges.'], ['Patio', 'Sweep and pick up ALL trash in the turf.'], ['Sugar station', 'Clean the holders, containers and surrounding surfaces; refill everything.']],
  Wednesday: [['Syrup bottles', 'Wash the bottles and spouts.'], ['Behind the bar floor', 'Sweep and mop; move equipment and scrub problem areas.'], ['Grinder deep clean', 'Disassemble and sanitize the hoppers and chute; purge stale grounds and oils from the burrs.'], ['Top of espresso machine', 'Sanitize the cups and the top panels.']],
  Thursday: [['Bar fridges', 'Scrub inside and outside.'], ['Curtis drip machine', 'Clean the brewer.'], ['Back-bar shelves deep clean', 'Remove everything and scrub all food residue from the surfaces.']],
  Friday: [['Scrub floor drains', 'Remove the covers; scrub the drains and the covers.'], ['Patio', 'Sweep and pick up trash in the turf.'], ['Sugar station', 'Clean the holders, containers and surrounding surfaces; refill everything.']],
  Saturday: [['Retail area', 'Dust the shelves, product and the top of the Grab & Go fridge.']],
  Sunday: [['Syrup bottles', 'Wash the bottles and spouts.'], ['Steam wand descale', 'Remove the tips, soak them in Rinza, then purge and wipe.'], ['Sugar station', 'Clean the holders, containers and surrounding surfaces; refill everything.']]
};
