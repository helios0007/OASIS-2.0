# Data gathered — 16 Nov 2026 (Claude Code)

Source PDFs are saved in `data/reference/`. Nothing in the model has been changed yet.

## 1. Tamil Nadu Schedule of Rates 2024-25, Volume I (PWD), effective 15.07.2024, basic rates excluding GST
`data/reference/TN_SoR_2024-25_Vol1.pdf` (text PDF, 338 pages). Page numbers below are PDF pages.

| OASIS item | Current estimate in `oasis/costs.py` | SoR item | SoR rate |
|---|---|---|---|
| White / cool roof | ₹300/m² (Telangana policy) | W-0354 solar reflective paint, SRI > 90 %, new surface, 3 coats 1 mm (p. 59) | **₹297/m²** |
| | | W-0353 same, existing surface incl. crack filling | ₹338/m² |
| | | W-0297 / W-0298 reflective + waterproof coating on existing screed (p. 43) | ₹629 / ₹822/m² |
| Roof insulation, 50 mm XPS | ₹1,005/m² (CPWD DSR 2023) | W-0333 overdeck XPS 50 mm, U 0.58 (p. 56) | **₹1,715/m²** |
| | | W-0338 underdeck XPS 50 mm (p. 57) | ₹1,565/m² |
| | | W-0329 cavity-wall XPS 50 mm (p. 56) | ₹1,415/m² |
| | | W-0324 external-wall XPS 50 mm (p. 55) | ₹2,365/m² |
| Mosquito mesh | ₹650/m² of window (estimate) | M-0195 fly-proof mesh, material only | ₹116.55/m² (+ frame, labour) |
| AAC wall | ₹1,350/m² (estimate) | M-0681 AAC block 600×200×200, M-0683 AAC joint mortar | ₹91.60 each (≈ ₹763/m² of wall in block alone); ₹612 per 40 kg bag |
| Brick wall | ₹1,480/m² 230 mm (estimate) | M-0010/0011 fly-ash brick 230×110×70/75 | ₹6,595 / ₹6,795 per 1,000 |
| (inputs) | | M-0001 cement ₹5,960/t; M-0125 M-sand ₹1,338/m³; M-0126 P-sand ₹1,343/m³; L-0029 brick mason I class ₹1,098/day; M-0416 cement paint ₹49.85/kg | |

Not in Vol I: finished rates for brickwork, blockwork, RCC sunshade, light roof finish. Those are in the PWD Buildings standard data / CPWD DSR. Wall and overhang rates can be built up from the material and labour rates above, or taken from the CPWD DSR.

## 2. Window glass: Eco-Niwas Samhita 2018 Part I (BEE)
`data/reference/BEE_Eco-Niwas_Samhita_2018_Part1.pdf`. The worked examples (Annexure 8) take "single clear glass with **SHGC 0.80**, VLT 85 %, **U 5.80 W/m²·K**".
→ **Matches `GLASS_U = 5.8`, `GLASS_SHGC = 0.8` exactly.** The check is closed.
- Warm-humid (Chennai): minimum openable window-to-floor ratio 16.66 %; RETV ≤ 15 W/m²; RETV coefficients a 5.15, b 1.31, c 65.21; roof U ≤ 1.2 W/m²·K.

## 3. AAC properties
- ENS 2018 Table 7, row 9 (source: CARBSE/CBERD materials database 2017): **642 kg/m³, 0.184 W/m·K, 1.24 kJ/kg·K**.
  `build_idf.py` has 642 / 0.184 / **794 J/kg·K**. Density and conductivity now have a source; **the specific heat is 36 % lower than ENS** and should be 1,240.
- IS 2185-3:1984 Table 1 (scanned, read by OCR): conductivity limits by density class are 0.21 (451–550), 0.24 (551–650) … 0.42 W/m·K. 0.184 is within the limit.
- ENS Table 7 also gives brick 1,920 / 0.98 / 0.80 and RCC 2,288 / 1.58 / 0.88, the same as SP 41.

## 4. Neighbourhood preset coordinates
| Preset | In `oasis/urban.py` | OpenStreetMap centre | Satellite at the preset (250 m) |
|---|---|---|---|
| Kannagi Nagar | 12.9365, 80.2370 | 12.9276, 80.2397 (≈1 km south) | 39 % covered, mean 5.8 m |
| Perumbakkam | 12.9050, 80.1960 | 12.9068, 80.1995 (suburb centroid) | 37 % covered, mean 5.0 m |
| Nungambakkam / T. Nagar / George Town | — | within ≈0.5 km of OSM | — |

Both resettlement presets fall on **low-rise ground (about 5 m)**, not on the tenement blocks. Dense mid-rise clusters found in a satellite scan of the area (**candidates, to confirm on a map**):
- Kannagi Nagar (G+3 tenements, about 12 m): 12.9329, 80.2414 (13 m, 45 % coverage); 12.9225, 80.2364 (13 m, 33 %).
- Perumbakkam (multi-storey TNUHDB blocks): 12.8950, 80.2070 (40 m, 25 %); 12.8866, 80.2065 (19 m, 30 %).

## Still needs the user
- A map pin on the actual tenement blocks for both estates.
- North arrow and party walls for the Amudha plans; a real Rhino-saved `.3dm`; the headline power-cut case.
- LHP Chennai booklet (`Downloads/ilide.info-02-lhp-chennai-booklet…pdf`), text read: **1,152 flats, G+5, carpet area 26.78 m² each**, plot 29,222 m², built-up 43,440 m²; precast concrete "3S" system (precast RCC columns, beams, shear walls, floor and roof slabs); AAC used in the walls; external walls get weatherproof acrylic paint. The floor plan is a drawing, so its room sizes still have to be read off by hand (or from the user).
