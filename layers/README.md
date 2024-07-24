# ATT&CK Navigator Layers

A layer constitutes a set of annotations on the ATT&CK matrix for a specific technology domain. Layers can also store a default configuration of the view such as sorting, visible platforms, and more. The ATT&CK Navigator includes functionalities for exporting annotations into layer files, as well as the ability to import layer files for viewing.

See the [layer format specification](LAYERFORMATv4_5.md) for more information about Layer files.

## Sample Layers

This repository includes a couple of [sample layers](samples/) demonstrating example use cases of layers and the ATT&CK Navigator. The scripts used to generate these layer files can be found in the [mitreattack-python repository](https://github.com/mitre-attack/attack-scripts/tree/master/scripts/layers/samples). These scripts may serve as examples on how to access and work with [ATT&CK data](https://github.com/mitre/cti).

## Layers showing updates to the ATT&CK knowledge base

[Updates to the ATT&CK knowledge base](https://attack.mitre.org/resources/updates/) are typically accompanied by layer files showing changes to techniques. Layers for relevant updates can be found in the [data/update_layers](data/update_layers) folder. The script used to generate these update layers [can be found in our attack-scripts repository](https://github.com/mitre-attack/attack-scripts/blob/master/scripts/diff_stix.py).

## Updating outdated layers

The sub-techniques update of ATT&CK caused many techniques to be replaced by sub-techniques. Since the replacing sub-techniques have different IDs, many layers created before the sub-technques release will still be using IDs for the replaced techniques and therefore won't work properly in the new version even if the annotation format is correct. [update-layers.py](update-layers.py) is a conversion script which both updates layers to the most recent format and also updates technique IDs that of their replacers where possible. There are however a few cases which won't be caught:
1. Cases where techniques which have been replaced by multiple sub-techniques are ignored entirely due to limitations in the remapping data.
2. Cases where the `tactic` field was present but the replacing technique is not in that tactic.
Run `python3 update-layers.py -h` for usage instructions.